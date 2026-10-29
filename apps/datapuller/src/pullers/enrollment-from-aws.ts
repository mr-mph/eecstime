/**
 * Sync with the AWS enrollment worker (infra/enrollment-worker).
 *
 *  - Publishes the class manifest (which classes.berkeley.edu pages to poll and
 *    how often) at most hourly. Popularity sets each class's fastest refresh;
 *    the worker backs a class off toward its slowest refresh while it isn't
 *    changing.
 *  - Imports every result batch the worker wrote since the last run into
 *    enrollment history + catalog_classes, in chronological order.
 *
 * Runs every 5 minutes from the dev scheduler. No-op unless
 * ENROLLMENT_WORKER_BUCKET (+ credentials) are set in .env.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { model, Schema } from "mongoose";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CatalogClassModel,
  EnrollmentRefreshClickModel,
  ISectionItem,
  SectionModel,
} from "@repo/common/models";
import {
  ENROLLMENT_WORKER_KEYS,
  EnrollmentWorkerBatch,
  EnrollmentWorkerClass,
  EnrollmentWorkerManifest,
  buildUcbCatalogUrl,
  decodeEnrollmentWorkerClassId,
  encodeEnrollmentWorkerClassId,
  isIndependentStudyNumber,
} from "@repo/shared";

import { updateCatalogEnrollment } from "../lib/catalog-denormalize";
import {
  CatalogEnrollmentPatch,
  persistScrapedClassEnrollment,
} from "../lib/ucb-enrollment-persist";
import { Config } from "../shared/config";
import { getCurrentCatalogTerm } from "../shared/term-selectors";
import { invalidateBackendCaches } from "./enrollment-from-public-backup";

const MANIFEST_MAX_AGE_MS = 60 * 60_000;
/**
 * Bump when buildManifest's rules change, so a restarted datapuller
 * republishes right away instead of waiting out MANIFEST_MAX_AGE_MS.
 */
const MANIFEST_RULES_VERSION = 2;
/** Cross-listing pages to fall back on when the primary listing is 0/0. */
const MAX_URLS_PER_CLASS = 3;

const MIN = 60;
const HOUR = 60 * MIN;
/**
 * Refresh bounds by priority group. The worker resets a class to its group's
 * fastest refresh whenever its numbers change and backs it off toward the
 * slowest while they don't; if demand exceeds the request budget everything
 * stretches proportionally. classes.berkeley.edu pages are CDN-cached for 15
 * minutes, so polling faster than that only re-reads the same cached copy.
 */
const GROUPS = {
  hot: {
    tier: "Hot: waitlisted, ≥90% full, most viewed or just refreshed",
    minIntervalSec: 15 * MIN,
    maxIntervalSec: 2 * HOUR,
  },
  undergrad: {
    tier: "Undergrad: everything else",
    minIntervalSec: 30 * MIN,
    maxIntervalSec: 2 * HOUR,
  },
  grad: {
    tier: "Grad / professional / no capacity",
    minIntervalSec: 6 * HOUR,
    maxIntervalSec: 24 * HOUR,
  },
} as const;
/** Undergrad classes this high in views + ratings count as hot. */
const HOT_BY_VIEWS = 300;
/** A class whose refresh button was used this recently counts as hot. */
const HOT_AFTER_REFRESH_MS = 6 * 60 * 60_000;
const HOT_FILL_RATIO = 0.9;

const SYNC_KEY = "enrollment-worker";

interface IEnrollmentWorkerSync {
  key: string;
  /** Last imported results/ object key. */
  cursor?: string | null;
  manifestPublishedAt?: Date | null;
  manifestClassCount?: number;
  /** "2027 Spring": the term the published manifest covers. */
  manifestTerm?: string | null;
  /** MANIFEST_RULES_VERSION of the published manifest. */
  manifestRulesVersion?: number | null;
}

const EnrollmentWorkerSyncModel = model<IEnrollmentWorkerSync>(
  "enrollment_worker_sync",
  new Schema<IEnrollmentWorkerSync>({
    key: { type: String, required: true, unique: true },
    cursor: { type: String, default: null },
    manifestPublishedAt: { type: Date, default: null },
    manifestClassCount: { type: Number },
    manifestTerm: { type: String, default: null },
    manifestRulesVersion: { type: Number, default: null },
  })
);

export const enrollmentWorkerEnabled = () =>
  !!process.env.ENROLLMENT_WORKER_BUCKET;

const s3Client = () =>
  new S3Client({
    region: process.env.ENROLLMENT_WORKER_REGION || "us-west-2",
    credentials: {
      accessKeyId: process.env.ENROLLMENT_WORKER_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.ENROLLMENT_WORKER_SECRET_ACCESS_KEY ?? "",
    },
  });

const popularityScore = (c: {
  enrolledCount?: number;
  waitlistedCount?: number;
  viewCount?: number;
  berkeleytimeRatingCount?: number;
}) =>
  (c.enrolledCount ?? 0) +
  2 * (c.waitlistedCount ?? 0) +
  0.5 * (c.viewCount ?? 0) +
  3 * (c.berkeleytimeRatingCount ?? 0);

/**
 * Independent study / research / field study: one section per instructor and
 * nothing for anyone else to enroll in, so not worth polling. 98/198 (DeCals,
 * group study) stay. Matches prefixes/suffixes like H199 or 299A.
 */
const isIndependentStudy = (courseNumber: string, component?: string) =>
  component === "IND" || isIndependentStudyNumber(courseNumber);

/** Numeric part of a catalog number: "C191A" -> 191. */
const catalogLevel = (courseNumber: string) =>
  Number(courseNumber.match(/\d+/)?.[0] ?? 0);

const buildManifest = async (
  log: Config["log"],
  term: { year: number; semester: string }
): Promise<EnrollmentWorkerManifest> => {
  // Only the latest term with catalog data (the catalog's default term, e.g.
  // Spring 2027 once it's released). The term in session is past its
  // enrollment rush and not worth the requests.
  const { year, semester } = term;
  const [classes, sections, clicks] = await Promise.all([
    CatalogClassModel.find({ year, semester })
      .select({
        sessionId: 1,
        subject: 1,
        courseNumber: 1,
        number: 1,
        enrolledCount: 1,
        maxEnroll: 1,
        waitlistedCount: 1,
        viewCount: 1,
        berkeleytimeRatingCount: 1,
        enrollmentUpdatedAt: 1,
      })
      .lean(),
    SectionModel.find({ year, semester })
      .select({
        sectionId: 1,
        sessionId: 1,
        subject: 1,
        courseNumber: 1,
        number: 1,
        component: 1,
        primary: 1,
        combinedSections: 1,
      })
      .lean(),
    EnrollmentRefreshClickModel.find({
      year,
      semester,
      at: { $gte: new Date(Date.now() - HOT_AFTER_REFRESH_MS) },
    })
      .select({ sessionId: 1, subject: 1, courseNumber: 1, number: 1 })
      .lean(),
  ]);
  const recentlyRefreshed = new Set(
    clicks.map((c) => `${c.sessionId}|${c.subject}|${c.courseNumber}|${c.number}`)
  );

  const byId = new Map(sections.map((s) => [String(s.sectionId), s]));
  const courseKey = (s: { sessionId: string; subject: string; courseNumber: string }) =>
    `${s.sessionId}|${s.subject}|${s.courseNumber}`;
  const primaryByKey = new Map(
    sections
      .filter((s) => s.primary)
      .map((s) => [`${courseKey(s)}|${s.number}`, s])
  );
  // Courses with labs/discussions (non-primary sections).
  const withAssociated = new Set(
    sections.filter((s) => !s.primary).map((s) => courseKey(s))
  );

  type Candidate = {
    entry: EnrollmentWorkerClass;
    score: number;
    group: keyof typeof GROUPS;
  };
  const candidates: Candidate[] = [];
  let independentStudy = 0;

  for (const c of classes) {
    const primary = primaryByKey.get(`${courseKey(c)}|${c.number}`);
    if (!primary?.component) continue;
    if (isIndependentStudy(c.courseNumber, primary.component)) {
      independentStudy += 1;
      continue;
    }
    const pages = [
      primary,
      ...(primary.combinedSections ?? [])
        .map((id) => byId.get(String(id)))
        .filter(
          (s): s is NonNullable<typeof s> =>
            !!s?.component && s.sectionId !== primary.sectionId
        ),
    ].slice(0, MAX_URLS_PER_CLASS);

    const enrolled = c.enrolledCount ?? 0;
    const max = c.maxEnroll ?? 0;
    // Only trust 0 capacity once a scrape has confirmed it; a newly released
    // term shows 0/0 everywhere until it's fetched.
    const confirmedNoCapacity = !!c.enrollmentUpdatedAt && max === 0 && enrolled === 0;
    const urgent =
      (c.waitlistedCount ?? 0) > 0 || (max > 0 && enrolled / max >= HOT_FILL_RATIO);

    candidates.push({
      entry: {
        id: encodeEnrollmentWorkerClassId({
          year,
          semester,
          sessionId: c.sessionId,
          subject: c.subject,
          courseNumber: c.courseNumber,
          number: c.number,
        }),
        urls: pages.map((s) =>
          buildUcbCatalogUrl({
            year,
            semester,
            subject: s.subject,
            courseNumber: s.courseNumber,
            number: s.number,
            component: s.component!,
          })
        ),
        associated: pages.some((s) => withAssociated.has(courseKey(s))),
        minIntervalSec: 0,
        maxIntervalSec: 0,
      },
      score: popularityScore(c),
      group: recentlyRefreshed.has(`${courseKey(c)}|${c.number}`)
        ? "hot"
        : catalogLevel(c.courseNumber) >= 200 || confirmedNoCapacity
          ? "grad"
          : urgent
            ? "hot"
            : "undergrad",
    });
  }

  // Most popular first: the worker fetches never-seen classes in this order.
  candidates.sort((a, b) => b.score - a.score);
  let undergradRank = 0;
  for (const candidate of candidates) {
    if (candidate.group === "undergrad" && undergradRank++ < HOT_BY_VIEWS) {
      candidate.group = "hot";
    }
    const group = GROUPS[candidate.group];
    candidate.entry.tier = group.tier;
    candidate.entry.minIntervalSec = group.minIntervalSec;
    candidate.entry.maxIntervalSec = group.maxIntervalSec;
  }

  const count = (g: keyof typeof GROUPS) =>
    candidates.filter((c) => c.group === g).length;
  const lectureOnly = candidates.filter((c) => !c.entry.associated).length;
  log.info(
    `Manifest: ${candidates.length} ${semester} ${year} classes ` +
      `(hot ${count("hot")}, undergrad ${count("undergrad")}, grad ${count("grad")}; ` +
      `${lectureOnly} without labs/discussions; skipped ${independentStudy} independent study)`
  );
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    classes: candidates.map((c) => c.entry),
  };
};

const publishManifestIfStale = async (
  s3: S3Client,
  bucket: string,
  log: Config["log"]
) => {
  const term = await getCurrentCatalogTerm();
  if (!term) {
    log.warn("No active term with catalog data; not publishing a manifest");
    return;
  }
  const termName = `${term.year} ${term.semester}`;
  const status = await EnrollmentWorkerSyncModel.findOne({ key: SYNC_KEY }).lean();
  const age = status?.manifestPublishedAt
    ? Date.now() - new Date(status.manifestPublishedAt).getTime()
    : Number.POSITIVE_INFINITY;
  // Republish hourly, or right away when the term or the rules change.
  if (
    age < MANIFEST_MAX_AGE_MS &&
    status?.manifestTerm === termName &&
    status?.manifestRulesVersion === MANIFEST_RULES_VERSION
  ) {
    return;
  }

  const manifest = await buildManifest(log, term);
  if (!manifest.classes.length) {
    log.warn("No classes to poll; not publishing an empty manifest");
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: ENROLLMENT_WORKER_KEYS.manifest,
      Body: gzipSync(JSON.stringify(manifest)),
      ContentType: "application/json",
      ContentEncoding: "gzip",
    })
  );
  await EnrollmentWorkerSyncModel.updateOne(
    { key: SYNC_KEY },
    {
      $set: {
        manifestPublishedAt: new Date(),
        manifestClassCount: manifest.classes.length,
        manifestTerm: termName,
        manifestRulesVersion: MANIFEST_RULES_VERSION,
      },
    },
    { upsert: true }
  );
};

const listNewBatchKeys = async (
  s3: S3Client,
  bucket: string,
  cursor: string | null
) => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: ENROLLMENT_WORKER_KEYS.resultsPrefix,
        StartAfter: cursor ?? undefined,
        ContinuationToken: token,
      })
    );
    for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    token = page.NextContinuationToken;
  } while (token);
  // ISO timestamps sort chronologically.
  return keys.sort();
};

const importBatch = async (batch: EnrollmentWorkerBatch, log: Config["log"]) => {
  const patchesByTerm = new Map<string, Map<string, CatalogEnrollmentPatch>>();
  let applied = 0;

  for (const result of batch.results) {
    // Cross-listings that follow this class's page get the same numbers.
    for (const id of [result.id, ...(result.alsoIds ?? [])]) {
      const key = decodeEnrollmentWorkerClassId(id);
      if (!key) continue;
      const primarySection = (await SectionModel.findOne({
        year: key.year,
        semester: key.semester,
        sessionId: key.sessionId,
        subject: key.subject,
        courseNumber: key.courseNumber,
        number: key.number,
        primary: true,
      }).lean()) as ISectionItem | null;
      if (!primarySection) continue;

      try {
        const patches = await persistScrapedClassEnrollment(
          key,
          primarySection,
          result.data,
          { aborted: false },
          new Date(result.observedAt ?? result.fetchedAt)
        );
        const termKey = `${key.year}|${key.semester}`;
        const termPatches = patchesByTerm.get(termKey) ?? new Map();
        for (const { sectionId, patch } of patches) termPatches.set(sectionId, patch);
        patchesByTerm.set(termKey, termPatches);
        applied += 1;
      } catch (error) {
        log.warn(
          `Failed to import ${id}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
  }

  for (const [termKey, patches] of patchesByTerm) {
    const [year, semester] = termKey.split("|");
    await updateCatalogEnrollment(log, Number(year), semester, patches);
  }
  return applied;
};

export const syncEnrollmentFromAws = async (config: Config) => {
  const log = config.log.getSubLogger({ name: "EnrollmentFromAws" });
  const bucket = process.env.ENROLLMENT_WORKER_BUCKET;
  if (!bucket) {
    log.info("ENROLLMENT_WORKER_BUCKET not set; skipping");
    return;
  }
  const s3 = s3Client();

  await publishManifestIfStale(s3, bucket, log);

  const status = await EnrollmentWorkerSyncModel.findOne({ key: SYNC_KEY }).lean();
  const keys = await listNewBatchKeys(s3, bucket, status?.cursor ?? null);
  if (!keys.length) {
    log.info("No new enrollment batches");
    return;
  }

  let classes = 0;
  for (const key of keys) {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const batch = JSON.parse(
      gunzipSync(await res.Body!.transformToByteArray()).toString("utf8")
    ) as EnrollmentWorkerBatch;
    classes += await importBatch(batch, log);
    // Advance per batch so a crash mid-way resumes where it left off.
    await EnrollmentWorkerSyncModel.updateOne(
      { key: SYNC_KEY },
      { $set: { cursor: key } },
      { upsert: true }
    );
  }

  log.info(`Imported ${classes} class enrollment snapshot(s) from ${keys.length} batch(es)`);
  await invalidateBackendCaches(config.BACKEND_URL, log);
};

export default { syncEnrollmentFromAws };
