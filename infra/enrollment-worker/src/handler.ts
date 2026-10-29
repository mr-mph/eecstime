/**
 * AWS Lambda: polls classes.berkeley.edu for enrollment, politely.
 *
 * Invoked every 5 minutes by EventBridge Scheduler; each run works for
 * RUN_BUDGET_MS and exits before the next one starts, so runs never overlap
 * and the request cap holds globally, not just per run.
 *
 * Rate: every outgoing request (a class page and its associated-sections page)
 * goes through one pacer that spaces request starts >= 1/MAX_RPS apart. A 429
 * or 503 stops the run and pauses the worker for THROTTLE_PAUSE_MS.
 *
 * Priority: each class has a refresh interval bounded by the manifest's
 * [minIntervalSec, maxIntervalSec] (min is set from popularity by the
 * datapuller). After a fetch the interval resets to min if seats/waitlist
 * changed, or grows by UNCHANGED_BACKOFF if not — so busy classes stay fast
 * and classes that never move drift to the max. Each run fetches the classes
 * that are most overdue relative to their own interval; when demand exceeds
 * the request budget everything stretches proportionally instead of starving.
 */
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  ENROLLMENT_WORKER_KEYS,
  type EnrollmentWorkerBatch,
  type EnrollmentWorkerClass,
  type EnrollmentWorkerManifest,
  type EnrollmentWorkerResult,
} from "../../../packages/shared/enrollmentWorker";
import {
  fetchUcbCatalogEnrollment,
  isBlankUcbEnrollment,
  type ParsedUcbCatalogEnrollment,
} from "../../../packages/shared/ucbCatalogEnrollment";

const BUCKET = process.env.BUCKET ?? "";
const MAX_RPS = Number(process.env.MAX_REQUESTS_PER_SECOND ?? "1");
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS ?? "270000");
const REQUEST_TIMEOUT_MS = 20_000;
const FLUSH_EVERY_MS = 60_000;
const THROTTLE_PAUSE_MS = 15 * 60_000;
const UNCHANGED_BACKOFF = 1.5;
const FAILURE_BACKOFF = 2;
const USER_AGENT =
  process.env.USER_AGENT ??
  "EECStimeEnrollmentWorker/1.0 (+https://eecstime.sethw.dev)";

const s3 = new S3Client({});

type ClassState = {
  /** Epoch ms of the last attempt. */
  last: number;
  intervalSec: number;
  hash?: string;
  fails?: number;
};

type SchedulerState = {
  version: 1;
  pausedUntil?: number;
  classes: Record<string, ClassState>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readJsonGz = async <T>(key: string): Promise<T | null> => {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return JSON.parse(gunzipSync(bytes).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof NoSuchKey) return null;
    throw error;
  }
};

const writeJsonGz = (key: string, value: unknown) =>
  s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: gzipSync(JSON.stringify(value)),
      ContentType: "application/json",
      ContentEncoding: "gzip",
    })
  );

/** Seat/waitlist numbers only, so cosmetic page changes don't count. */
const enrollmentHash = (data: ParsedUcbCatalogEnrollment) =>
  createHash("sha1")
    .update(
      JSON.stringify(
        [data.primary, ...data.associatedSections].map((s) => [
          s.sectionId,
          s.status,
          s.enrolledCount,
          s.waitlistedCount,
          s.maxEnroll,
          s.maxWaitlist,
          s.openReserved,
          s.seatReservationCount,
        ])
      )
    )
    .digest("base64url");

/**
 * classes.berkeley.edu sits behind a CDN that caches pages for up to 15
 * minutes, so the numbers can be older than our request. Last-Modified is
 * when Drupal rendered the page; fall back to Date - Age, then to now.
 */
const generatedAt = (response: Response): number => {
  const now = Date.now();
  const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
  if (Number.isFinite(lastModified)) return Math.min(lastModified, now);
  const date = Date.parse(response.headers.get("date") ?? "");
  const age = Number(response.headers.get("age") ?? "0");
  if (Number.isFinite(date)) {
    return Math.min(date - (Number.isFinite(age) ? age : 0) * 1000, now);
  }
  return now;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Classes due now, most overdue (relative to their own interval) first. */
const dueClasses = (
  manifest: EnrollmentWorkerManifest,
  state: SchedulerState,
  now: number
) =>
  manifest.classes
    .map((c) => {
      const s = state.classes[c.id];
      if (!s) return { c, ratio: Number.POSITIVE_INFINITY };
      const interval = clamp(s.intervalSec, c.minIntervalSec, c.maxIntervalSec);
      return { c, ratio: (now - s.last) / 1000 / interval };
    })
    .filter(({ ratio }) => ratio >= 1)
    .sort(
      (a, b) => b.ratio - a.ratio || a.c.minIntervalSec - b.c.minIntervalSec
    )
    .map(({ c }) => c);

export const handler = async () => {
  if (!BUCKET) throw new Error("BUCKET env var is required");
  const started = Date.now();

  const [manifest, savedState] = await Promise.all([
    readJsonGz<EnrollmentWorkerManifest>(ENROLLMENT_WORKER_KEYS.manifest),
    readJsonGz<SchedulerState>(ENROLLMENT_WORKER_KEYS.state),
  ]);
  if (!manifest?.classes.length) {
    console.log("No manifest yet; nothing to do");
    return;
  }
  const state: SchedulerState = savedState ?? { version: 1, classes: {} };
  if (state.pausedUntil && state.pausedUntil > started) {
    console.log(`Paused after throttling until ${new Date(state.pausedUntil).toISOString()}`);
    return;
  }

  // One pacer for every request this run makes.
  const gapMs = 1000 / MAX_RPS;
  let nextSlot = 0;
  let requests = 0;
  let throttled = false;
  /** When the first (class) page of the current attempt was generated. */
  let pageGeneratedAt: number | null = null;
  const pacedFetch: typeof fetch = async (input, init) => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gapMs;
    if (at > now) await sleep(at - now);
    requests += 1;
    const response = await fetch(input, init);
    if (response.status === 429 || response.status === 503) throttled = true;
    pageGeneratedAt ??= generatedAt(response);
    return response;
  };

  const fetchClass = async (c: EnrollmentWorkerClass) => {
    for (const url of c.urls) {
      if (throttled) return null;
      pageGeneratedAt = null;
      try {
        const data = await fetchUcbCatalogEnrollment(url, {
          fetch: pacedFetch,
          userAgent: USER_AGENT,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!isBlankUcbEnrollment(data.primary)) return data;
      } catch {
        // Try the next cross-listing; persistent failures back off below.
      }
    }
    return null;
  };

  let pending: EnrollmentWorkerResult[] = [];
  let lastFlush = Date.now();
  const flush = async () => {
    if (!pending.length) return;
    const batch: EnrollmentWorkerBatch = {
      version: 1,
      writtenAt: new Date().toISOString(),
      results: pending,
    };
    pending = [];
    lastFlush = Date.now();
    await writeJsonGz(
      `${ENROLLMENT_WORKER_KEYS.resultsPrefix}${batch.writtenAt}.json.gz`,
      batch
    );
  };

  const queue = dueClasses(manifest, state, started);
  let ok = 0;
  let changed = 0;
  let failed = 0;
  // Leave room for a class's worst case (2 requests that both time out).
  const stopAt = started + RUN_BUDGET_MS - 2 * REQUEST_TIMEOUT_MS;

  for (const c of queue) {
    if (Date.now() >= stopAt || throttled) break;
    const prev = state.classes[c.id];
    const interval = clamp(
      prev?.intervalSec ?? c.minIntervalSec,
      c.minIntervalSec,
      c.maxIntervalSec
    );
    const data = await fetchClass(c);
    const fetchedAt = Date.now();
    const observedAt = pageGeneratedAt ?? fetchedAt;

    if (data) {
      const hash = enrollmentHash(data);
      const didChange = hash !== prev?.hash;
      state.classes[c.id] = {
        last: fetchedAt,
        intervalSec: didChange
          ? c.minIntervalSec
          : clamp(interval * UNCHANGED_BACKOFF, c.minIntervalSec, c.maxIntervalSec),
        hash,
      };
      pending.push({
        id: c.id,
        observedAt: new Date(observedAt).toISOString(),
        fetchedAt: new Date(fetchedAt).toISOString(),
        data,
      });
      ok += 1;
      if (didChange) changed += 1;
    } else if (!throttled) {
      state.classes[c.id] = {
        last: fetchedAt,
        intervalSec: clamp(interval * FAILURE_BACKOFF, c.minIntervalSec, c.maxIntervalSec),
        hash: prev?.hash,
        fails: (prev?.fails ?? 0) + 1,
      };
      failed += 1;
    }

    if (Date.now() - lastFlush >= FLUSH_EVERY_MS) await flush();
  }

  await flush();

  if (throttled) state.pausedUntil = Date.now() + THROTTLE_PAUSE_MS;
  else delete state.pausedUntil;
  // Drop classes that left the manifest so state stays bounded.
  const ids = new Set(manifest.classes.map((c) => c.id));
  for (const id of Object.keys(state.classes)) {
    if (!ids.has(id)) delete state.classes[id];
  }
  await writeJsonGz(ENROLLMENT_WORKER_KEYS.state, state);

  const seconds = (Date.now() - started) / 1000;
  console.log(
    JSON.stringify({
      due: queue.length,
      fetched: ok,
      changed,
      failed,
      requests,
      requestsPerSecond: seconds ? Number((requests / seconds).toFixed(2)) : 0,
      throttled,
      seconds: Number(seconds.toFixed(1)),
    })
  );
};
