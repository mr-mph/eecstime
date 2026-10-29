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

import { parseTermName } from "@repo/common";
import {
  CatalogClassModel,
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
} from "@repo/shared";

import { updateCatalogEnrollment } from "../lib/catalog-denormalize";
import {
  CatalogEnrollmentPatch,
  persistScrapedClassEnrollment,
} from "../lib/ucb-enrollment-persist";
import { Config } from "../shared/config";
import { getActiveTerms } from "../shared/term-selectors";
import { invalidateBackendCaches } from "./enrollment-from-public-backup";

const MANIFEST_MAX_AGE_MS = 60 * 60_000;
/** Cross-listing pages to fall back on when the primary listing is 0/0. */
const MAX_URLS_PER_CLASS = 3;

const MIN = 60;
const HOUR = 60 * MIN;
/**
 * Fastest refresh by popularity rank (across all polled classes). The worker
 * stretches these when a class isn't changing, and stretches everything
 * proportionally if demand exceeds the 1 req/s budget.
 */
const POPULARITY_TIERS: { maxRank: number; minIntervalSec: number }[] = [
  // classes.berkeley.edu pages are CDN-cached for 15 minutes; polling faster
  // only re-reads the same cached copy.
  { maxRank: 100, minIntervalSec: 15 * MIN },
  { maxRank: 500, minIntervalSec: 30 * MIN },
  { maxRank: 2000, minIntervalSec: 2 * HOUR },
  { maxRank: Number.POSITIVE_INFINITY, minIntervalSec: 6 * HOUR },
];
const MAX_INTERVAL_SEC = 24 * HOUR;
/** Grad, consent-gated or zero-capacity classes rarely move. */
const GATED_MIN_INTERVAL_SEC = 6 * HOUR;
const GATED_MAX_INTERVAL_SEC = 48 * HOUR;

const SYNC_KEY = "enrollment-worker";

interface IEnrollmentWorkerSync {
  key: string;
  /** Last imported results/ object key. */
  cursor?: string | null;
  manifestPublishedAt?: Date | null;
  manifestClassCount?: number;
}

const EnrollmentWorkerSyncModel = model<IEnrollmentWorkerSync>(
  "enrollment_worker_sync",
  new Schema<IEnrollmentWorkerSync>({
    key: { type: String, required: true, unique: true },
    cursor: { type: String, default: null },
    manifestPublishedAt: { type: Date, default: null },
    manifestClassCount: { type: Number },
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

/** SIS consent codes: N = none, I = instructor, D = department. */
const needsConsent = (code?: string) => code === "I" || code === "D";

const buildManifest = async (
  log: Config["log"]
): Promise<EnrollmentWorkerManifest> => {
  // Every active (current/upcoming), non-tentative term with catalog data.
  const terms = new Map<string, { year: number; semester: string }>();
  for (const term of await getActiveTerms()) {
    const parsed = parseTermName(term.name);
    if (parsed) terms.set(term.name, parsed);
  }

  type Candidate = { entry: EnrollmentWorkerClass; score: number; gated: boolean };
  const candidates: Candidate[] = [];

  for (const { year, semester } of terms.values()) {
    const [classes, sections] = await Promise.all([
      CatalogClassModel.find({ year, semester })
        .select({
          sessionId: 1,
          subject: 1,
          courseNumber: 1,
          number: 1,
          academicCareer: 1,
          enrolledCount: 1,
          maxEnroll: 1,
          waitlistedCount: 1,
          viewCount: 1,
          berkeleytimeRatingCount: 1,
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
          addConsentRequired: 1,
        })
        .lean(),
    ]);
    if (!classes.length) continue;

    const byId = new Map(sections.map((s) => [String(s.sectionId), s]));
    const primaryByKey = new Map(
      sections
        .filter((s) => s.primary)
        .map((s) => [
          `${s.sessionId}|${s.subject}|${s.courseNumber}|${s.number}`,
          s,
        ])
    );

    for (const c of classes) {
      const primary = primaryByKey.get(
        `${c.sessionId}|${c.subject}|${c.courseNumber}|${c.number}`
      );
      if (!primary?.component) continue;
      const pages = [
        primary,
        ...(primary.combinedSections ?? [])
          .map((id) => byId.get(String(id)))
          .filter(
            (s): s is NonNullable<typeof s> =>
              !!s?.component && s.sectionId !== primary.sectionId
          ),
      ].slice(0, MAX_URLS_PER_CLASS);

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
          minIntervalSec: 0,
          maxIntervalSec: 0,
        },
        score: popularityScore(c),
        gated:
          c.academicCareer === "GRAD" ||
          needsConsent(primary.addConsentRequired) ||
          (c.maxEnroll === 0 && (c.enrolledCount ?? 0) === 0),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((candidate, rank) => {
    const tier = POPULARITY_TIERS.find((t) => rank < t.maxRank)!;
    candidate.entry.minIntervalSec = candidate.gated
      ? Math.max(tier.minIntervalSec, GATED_MIN_INTERVAL_SEC)
      : tier.minIntervalSec;
    candidate.entry.maxIntervalSec = candidate.gated
      ? GATED_MAX_INTERVAL_SEC
      : MAX_INTERVAL_SEC;
  });

  const gated = candidates.filter((c) => c.gated).length;
  log.info(
    `Manifest: ${candidates.length} classes across ${terms.size} term(s) (${gated} gated)`
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
  const status = await EnrollmentWorkerSyncModel.findOne({ key: SYNC_KEY }).lean();
  const age = status?.manifestPublishedAt
    ? Date.now() - new Date(status.manifestPublishedAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (age < MANIFEST_MAX_AGE_MS) return;

  const manifest = await buildManifest(log);
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
