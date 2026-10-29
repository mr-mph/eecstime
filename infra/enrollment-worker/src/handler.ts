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
  type EnrollmentWorkerFetchEvent,
  type EnrollmentWorkerLiveStatus,
  type EnrollmentWorkerResult,
  type EnrollmentWorkerRunSummary,
  withIndependentStudyLowest,
} from "../../../packages/shared/enrollmentWorker";
import {
  fetchUcbCatalogEnrollment,
  isBlankUcbEnrollment,
  type ParsedUcbCatalogEnrollment,
} from "../../../packages/shared/ucbCatalogEnrollment";

const BUCKET = process.env.BUCKET ?? "";
const MAX_RPS = Number(process.env.MAX_REQUESTS_PER_SECOND ?? "3");
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS ?? "270000");
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Classes fetched at once, adapted while running: every ADAPT_EVERY_MS the
 * limit grows by ADAPT_STEP while requests are healthy (few timeouts/5xx,
 * latency near the best seen) and is cut by ADAPT_CUT when they aren't. The
 * limit carries over between runs. The pacer still spaces request starts at
 * least 1/MAX_RPS apart, and a 429/503 still stops the run.
 */
const CONCURRENCY_START = Number(process.env.CONCURRENCY ?? "8");
const CONCURRENCY_MIN = 2;
const CONCURRENCY_MAX = Number(process.env.MAX_CONCURRENCY ?? "24");
const ADAPT_EVERY_MS = Number(process.env.ADAPT_EVERY_MS ?? "30000");
const ADAPT_MIN_SAMPLES = 10;
const ADAPT_STEP = 2;
const ADAPT_CUT = 0.6;
/** Grow while at most this share of requests fail (network, timeout, 5xx)... */
const ADAPT_OK_FAIL_RATE = 0.1;
/** ...and median latency stays within this factor of the best seen. */
const ADAPT_OK_LATENCY = 1.5;
/** Cut when failures or latency pass these. */
const ADAPT_BAD_FAIL_RATE = 0.2;
const ADAPT_BAD_LATENCY = 2.5;
const FLUSH_EVERY_MS = 60_000;
const THROTTLE_PAUSE_MS = 15 * 60_000;
const UNCHANGED_BACKOFF = 1.5;
const FAILURE_BACKOFF = 2;
/** Re-check a cross-listing follower's own page this often. */
const FOLLOWER_RECHECK_MS = 24 * 60 * 60_000;
/**
 * Couldn't reach the page (network error, timeout, 5xx): retry first thing
 * next run, at most this many times, with these timeouts if it timed out.
 * Pages that answered but had no usable data back off instead.
 */
const RETRY_TIMEOUTS_MS = [45_000, 60_000];
/** Never start a request that could run past this point (Lambda timeout 295s). */
const SAFE_END_MS = 285_000;
/** Dashboard live-status write interval. */
const LIVE_STATUS_EVERY_MS = 10_000;
const LIVE_RECENT = 60;
const ERROR_HISTORY = 100;
/** Pseudo class id for run-level events (throttling). */
const RUN_EVENT_ID = "run";
const RUN_HISTORY = 48;
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
  /**
   * Cross-listing follower: this class's own page is blank and its numbers
   * come from this sibling page. While fresh, the class isn't fetched on its
   * own; it rides along with whichever class owns that page.
   */
  via?: string;
  viaCheckedAt?: number;
  /** Couldn't reach the page: retry it first next run with this timeout. */
  retryTimeoutMs?: number;
  /** Consecutive quick retries used (see RETRY_TIMEOUTS_MS). */
  timeoutRetries?: number;
  /** Epoch ms of the last successful fetch. */
  okAt?: number;
};

type SchedulerState = {
  version: 1;
  pausedUntil?: number;
  classes: Record<string, ClassState>;
  /** Recent run summaries, newest last (for the dashboard). */
  runs?: EnrollmentWorkerRunSummary[];
  /** Recent failures, newest first (for the dashboard). */
  errors?: EnrollmentWorkerFetchEvent[];
  /** Adaptive concurrency limit carried between runs. */
  concurrency?: number;
  /** Best (lowest) median request latency seen, drifting slowly upward. */
  originLatencyBaselineMs?: number;
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

const writeJson = (key: string, value: unknown) =>
  s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );

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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const isTimeout = (error: unknown) =>
  error instanceof Error && /timeout|timed out/i.test(error.message);

/**
 * The page couldn't be reached (network error, timeout, server error), as
 * opposed to a page that answered without usable enrollment data (404,
 * missing/blank numbers, unparseable), which retrying soon won't fix.
 */
const isUnreachable = (error: unknown) =>
  error instanceof Error &&
  /Failed to reach|Timed out reading|returned HTTP 5\d\d|timeout/i.test(error.message);

/**
 * Group cross-listings: a class whose numbers come from another manifest
 * class's page (state.via) follows that class instead of being fetched.
 * The leader inherits the fastest refresh of its group.
 */
const groupFollowers = (
  manifest: EnrollmentWorkerManifest,
  state: SchedulerState,
  now: number
) => {
  const byOwnPage = new Map(manifest.classes.map((c) => [c.urls[0], c]));
  const followersOf = new Map<string, string[]>();
  const followers = new Set<string>();
  for (const c of manifest.classes) {
    const s = state.classes[c.id];
    if (!s?.via || !s.viaCheckedAt || now - s.viaCheckedAt > FOLLOWER_RECHECK_MS) {
      continue;
    }
    const leader = byOwnPage.get(s.via);
    if (!leader || leader.id === c.id || state.classes[leader.id]?.via) continue;
    followersOf.set(leader.id, [...(followersOf.get(leader.id) ?? []), c.id]);
    followers.add(c.id);
  }
  const byId = new Map(manifest.classes.map((c) => [c.id, c]));
  const groupMinInterval = new Map<string, number>();
  for (const [leaderId, ids] of followersOf) {
    groupMinInterval.set(
      leaderId,
      Math.min(...[leaderId, ...ids].map((id) => byId.get(id)!.minIntervalSec))
    );
  }
  return { followersOf, followers, groupMinInterval };
};

/**
 * Never attempted: no successful fetch and no failed attempt yet. Seeded state
 * only records when the class was first seen.
 */
const isBacklog = (s: ClassState | undefined) => !s || (!s.hash && !s.okAt && !s.fails);

/**
 * Classes to fetch this run, in order:
 *  1. classes whose page couldn't be reached last run (quick retry);
 *  2. the backlog: every class never attempted, most popular first (the
 *     manifest is sorted by popularity), so each class gets at least one
 *     fetch as soon as possible;
 *  3. refreshes, most overdue relative to their own interval first.
 * A backlog class that fails drops out of (2) into normal failure backoff,
 * so a dead page can't hold the front of the queue.
 */
const dueClasses = (
  manifest: EnrollmentWorkerManifest,
  state: SchedulerState,
  now: number,
  followers: Set<string>,
  minIntervalOf: (c: EnrollmentWorkerClass) => number
) => {
  const retries: EnrollmentWorkerClass[] = [];
  const backlog: EnrollmentWorkerClass[] = [];
  const refreshes: { c: EnrollmentWorkerClass; minInterval: number; ratio: number }[] = [];
  // Independent study: only once everything else is done.
  const lowest: { c: EnrollmentWorkerClass; ratio: number }[] = [];
  for (const c of manifest.classes as (EnrollmentWorkerClass & { lowest?: boolean })[]) {
    if (followers.has(c.id)) continue;
    const s = state.classes[c.id];
    if (c.lowest) {
      const interval = clamp(s?.intervalSec ?? c.minIntervalSec, c.minIntervalSec, c.maxIntervalSec);
      const ratio = isBacklog(s) ? Number.POSITIVE_INFINITY : (now - s!.last) / 1000 / interval;
      if (ratio >= 1) lowest.push({ c, ratio });
    } else if (s?.retryTimeoutMs) {
      retries.push(c);
    } else if (isBacklog(s)) {
      backlog.push(c);
    } else {
      const minInterval = minIntervalOf(c);
      const interval = clamp(s!.intervalSec, minInterval, c.maxIntervalSec);
      const ratio = (now - s!.last) / 1000 / interval;
      if (ratio >= 1) refreshes.push({ c, minInterval, ratio });
    }
  }
  refreshes.sort((a, b) => b.ratio - a.ratio || a.minInterval - b.minInterval);
  lowest.sort((a, b) => b.ratio - a.ratio);
  return {
    queue: [
      ...retries,
      ...backlog,
      ...refreshes.map(({ c }) => c),
      ...lowest.map(({ c }) => c),
    ],
    backlog: backlog.length,
  };
};

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
  manifest.classes = withIndependentStudyLowest(manifest.classes);
  const state: SchedulerState = savedState ?? { version: 1, classes: {} };
  if (state.pausedUntil && state.pausedUntil > started) {
    console.log(`Paused after throttling until ${new Date(state.pausedUntil).toISOString()}`);
    await writeJson(ENROLLMENT_WORKER_KEYS.liveStatus, {
      version: 1,
      updatedAt: started,
      run: {
        state: "paused",
        startedAt: started,
        budgetEndsAt: started,
        finishedAt: started,
        pausedUntil: state.pausedUntil,
        due: 0,
        fetched: 0,
        changed: 0,
        failed: 0,
        requests: 0,
        concurrency: state.concurrency ?? CONCURRENCY_START,
        maxRequestsPerSecond: MAX_RPS,
      },
      inFlight: [],
      recent: [],
      errors: state.errors ?? [],
    } satisfies EnrollmentWorkerLiveStatus);
    return;
  }

  // One pacer for every request this run makes. Callers take turns, and each
  // start is measured from the previous request's *actual* start, so a late
  // timer or busy event loop can never squeeze two starts closer than gapMs.
  const gapMs = 1000 / MAX_RPS;
  let gate: Promise<void> = Promise.resolve();
  let lastStart = 0;
  const acquireSlot = () =>
    (gate = gate.then(async () => {
      const wait = lastStart + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      // setTimeout can fire a hair early.
      while (Date.now() < lastStart + gapMs) await sleep(1);
      lastStart = Date.now();
    }));
  let requests = 0;
  let throttled = false;
  let inFlight = 0;
  let maxInFlight = 0;
  // Adaptive concurrency: request outcomes since the last adjustment.
  let limit = clamp(
    Math.round(state.concurrency ?? CONCURRENCY_START),
    CONCURRENCY_MIN,
    CONCURRENCY_MAX
  );
  // `cached`: served by the CDN (fast regardless of how loaded the origin is),
  // so it counts toward the failure rate but not the latency check.
  let samples: { ms: number; ok: boolean; cached: boolean }[] = [];
  const pacedFetch: typeof fetch = async (input, init) => {
    await acquireSlot();
    requests += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const t0 = Date.now();
    try {
      const response = await fetch(input, init);
      if (response.status === 429 || response.status === 503) throttled = true;
      samples.push({
        ms: Date.now() - t0,
        ok: response.status < 500,
        // e.g. "MISS, MISS, HIT" — any HIT means a CDN layer answered.
        cached: /\bHIT\b/i.test(response.headers.get("x-cache") ?? ""),
      });
      return response;
    } catch (error) {
      samples.push({ ms: Date.now() - t0, ok: false, cached: false });
      throw error;
    } finally {
      inFlight -= 1;
    }
  };
  const adapt = () => {
    if (samples.length < ADAPT_MIN_SAMPLES) return;
    const failRate = samples.filter((s) => !s.ok).length / samples.length;
    // Latency is judged on uncached (origin) responses only.
    const originMs = samples
      .filter((s) => s.ok && !s.cached)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    const median =
      originMs.length >= 3 ? originMs[Math.floor(originMs.length / 2)] : null;
    samples = [];
    if (median !== null) {
      // Drift up slowly so a site that's slower overall isn't penalized forever.
      state.originLatencyBaselineMs = Math.min(median, (state.originLatencyBaselineMs ?? median) * 1.02);
    }
    const baseline = state.originLatencyBaselineMs ?? median ?? 0;
    const slow = median !== null && median > baseline * ADAPT_BAD_LATENCY;
    const fast = median === null || median <= baseline * ADAPT_OK_LATENCY;
    const before = limit;
    if (failRate > ADAPT_BAD_FAIL_RATE || slow) {
      limit = Math.max(CONCURRENCY_MIN, Math.floor(limit * ADAPT_CUT));
    } else if (failRate <= ADAPT_OK_FAIL_RATE && fast) {
      limit = Math.min(CONCURRENCY_MAX, limit + ADAPT_STEP);
    }
    if (limit !== before) {
      console.log(
        `concurrency ${before} -> ${limit} (fail ${(failRate * 100).toFixed(0)}%, origin median ${median ?? "n/a"}ms, baseline ${Math.round(baseline)}ms)`
      );
    }
  };

  /**
   * Try the class's pages in order (a known-good sibling page first if its
   * own page was blank recently). Returns the data and which page served it.
   */
  const fetchClass = async (
    c: EnrollmentWorkerClass,
    timeoutMs: number,
    knownVia: string | undefined
  ) => {
    const urls = knownVia
      ? [knownVia, ...c.urls.filter((u) => u !== knownVia)]
      : c.urls;
    let timedOut = false;
    let unreachable = false;
    let error: string | undefined;
    for (const url of urls) {
      if (throttled) break;
      try {
        const data = await fetchUcbCatalogEnrollment(url, {
          fetch: pacedFetch,
          userAgent: USER_AGENT,
          timeoutMs,
          associated: c.associated !== false,
        });
        if (!isBlankUcbEnrollment(data.primary)) {
          return {
            data,
            url,
            timedOut,
            unreachable,
            pageGeneratedAt: data.pageGeneratedAt ?? null,
            error,
          };
        }
        error = "page has no enrollment numbers";
      } catch (err) {
        // Try the next cross-listing; persistent failures back off below.
        if (isTimeout(err)) timedOut = true;
        if (isUnreachable(err)) unreachable = true;
        error = err instanceof Error ? err.message : String(err);
      }
    }
    return { data: null, url: null, timedOut, unreachable, pageGeneratedAt: null, error };
  };

  let pending: EnrollmentWorkerResult[] = [];
  let lastFlush = Date.now();
  let flushing: Promise<void> = Promise.resolve();
  // Serialized so concurrent workers never write two batches with one key.
  const flush = () => (flushing = flushing.then(flushNow));
  const flushNow = async () => {
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

  const { followersOf, followers, groupMinInterval } = groupFollowers(
    manifest,
    state,
    started
  );
  const minIntervalOf = (c: EnrollmentWorkerClass) =>
    groupMinInterval.get(c.id) ?? c.minIntervalSec;
  // Record when each class was first seen (it stays in the backlog until its
  // first attempt; see dueClasses).
  let seeded = 0;
  for (const c of manifest.classes) {
    if (state.classes[c.id]) continue;
    const interval = minIntervalOf(c);
    state.classes[c.id] = { last: started - interval * 1000, intervalSec: interval };
    seeded += 1;
  }
  const { queue, backlog } = dueClasses(
    manifest,
    state,
    started,
    followers,
    minIntervalOf
  );
  const byId = new Map(manifest.classes.map((c) => [c.id, c]));
  let ok = 0;
  let changed = 0;
  let failed = 0;
  let retried = 0;
  let followerUpdates = 0;

  // Live status for the dashboard.
  const inFlightClasses = new Map<
    string,
    { id: string; url: string; startedAt: number; timeoutMs: number }
  >();
  const recent: EnrollmentWorkerFetchEvent[] = [];
  const errors: EnrollmentWorkerFetchEvent[] = [...(state.errors ?? [])];
  const record = (event: EnrollmentWorkerFetchEvent) => {
    recent.unshift(event);
    if (recent.length > LIVE_RECENT) recent.length = LIVE_RECENT;
    if (!event.ok) {
      errors.unshift(event);
      if (errors.length > ERROR_HISTORY) errors.length = ERROR_HISTORY;
    }
  };
  let finishedAt: number | null = null;
  const liveStatus = (): EnrollmentWorkerLiveStatus => ({
    version: 1,
    updatedAt: Date.now(),
    run: {
      state: finishedAt ? "finished" : "running",
      startedAt: started,
      budgetEndsAt: started + RUN_BUDGET_MS,
      finishedAt,
      pausedUntil: state.pausedUntil ?? null,
      due: queue.length,
      fetched: ok,
      changed,
      failed,
      requests,
      concurrency: limit,
      maxRequestsPerSecond: MAX_RPS,
    },
    inFlight: [...inFlightClasses.values()],
    recent,
    errors,
  });
  let liveWrite: Promise<unknown> = Promise.resolve();
  const writeLive = () =>
    (liveWrite = liveWrite
      .then(() => writeJson(ENROLLMENT_WORKER_KEYS.liveStatus, liveStatus()))
      .catch((error) => console.warn("live status write failed", error)));
  void writeLive();
  const liveTimer = setInterval(() => void writeLive(), LIVE_STATUS_EVERY_MS);

  const processClass = async (c: EnrollmentWorkerClass) => {
    const prev = state.classes[c.id];
    const timeoutMs = prev?.retryTimeoutMs ?? REQUEST_TIMEOUT_MS;
    // Worst case is two requests that both time out.
    if (Date.now() + 2 * timeoutMs > started + SAFE_END_MS) return;
    const minInterval = minIntervalOf(c);
    const interval = clamp(
      prev?.intervalSec ?? minInterval,
      minInterval,
      c.maxIntervalSec
    );
    const viaFresh =
      !!prev?.via &&
      !!prev.viaCheckedAt &&
      started - prev.viaCheckedAt <= FOLLOWER_RECHECK_MS;
    if (prev?.retryTimeoutMs) retried += 1;

    const classStarted = Date.now();
    inFlightClasses.set(c.id, {
      id: c.id,
      url: viaFresh ? prev!.via! : c.urls[0],
      startedAt: classStarted,
      timeoutMs,
    });
    const { data, url, timedOut, unreachable, pageGeneratedAt, error } = await fetchClass(
      c,
      timeoutMs,
      viaFresh ? prev!.via : undefined
    ).finally(() => inFlightClasses.delete(c.id));
    const fetchedAt = Date.now();
    const observedAt = pageGeneratedAt ?? fetchedAt;

    if (data && url) {
      const hash = enrollmentHash(data);
      const didChange = hash !== prev?.hash;
      const nextInterval = didChange
        ? minInterval
        : clamp(interval * UNCHANGED_BACKOFF, minInterval, c.maxIntervalSec);
      // Served by a sibling page: remember it. Only a fetch that tried this
      // class's own page first (re)confirms the follower relationship.
      const via = url !== c.urls[0] ? url : undefined;
      state.classes[c.id] = {
        last: fetchedAt,
        intervalSec: nextInterval,
        hash,
        via,
        viaCheckedAt: via ? (viaFresh ? prev!.viaCheckedAt : fetchedAt) : undefined,
        okAt: fetchedAt,
      };
      const alsoIds = followersOf.get(c.id) ?? [];
      for (const id of alsoIds) {
        const f = byId.get(id)!;
        state.classes[id] = {
          ...state.classes[id],
          last: fetchedAt,
          intervalSec: clamp(nextInterval, f.minIntervalSec, f.maxIntervalSec),
          hash,
          okAt: fetchedAt,
        };
      }
      followerUpdates += alsoIds.length;
      pending.push({
        id: c.id,
        ...(alsoIds.length ? { alsoIds } : {}),
        observedAt: new Date(observedAt).toISOString(),
        fetchedAt: new Date(fetchedAt).toISOString(),
        data,
      });
      ok += 1;
      if (didChange) changed += 1;
      record({
        id: c.id,
        url,
        at: fetchedAt,
        ok: true,
        observedAt,
        enrolled: data.primary.enrolledCount,
        max: data.primary.maxEnroll,
        waitlisted: data.primary.waitlistedCount,
        changed: didChange,
        followers: alsoIds.length || undefined,
        ms: fetchedAt - classStarted,
      });
    } else if (!throttled) {
      const retries = prev?.timeoutRetries ?? 0;
      const quickRetry =
        unreachable &&
        !(c as { lowest?: boolean }).lowest &&
        retries < RETRY_TIMEOUTS_MS.length;
      const retryTimeout = timedOut ? RETRY_TIMEOUTS_MS[retries] : REQUEST_TIMEOUT_MS;
      state.classes[c.id] = {
        ...prev,
        last: fetchedAt,
        // Unreachable: keep the interval and jump the queue next run (with a
        // longer timeout if it timed out). Bad/blank page: back off.
        intervalSec: quickRetry
          ? interval
          : clamp(interval * FAILURE_BACKOFF, minInterval, c.maxIntervalSec),
        fails: (prev?.fails ?? 0) + 1,
        retryTimeoutMs: quickRetry ? retryTimeout : undefined,
        timeoutRetries: quickRetry ? retries + 1 : undefined,
      };
      failed += 1;
      record({
        id: c.id,
        url: viaFresh ? prev!.via : c.urls[0],
        at: fetchedAt,
        ok: false,
        error: quickRetry
          ? `${error ?? "failed"} (retrying first next run${timedOut ? `, ${retryTimeout / 1000}s timeout` : ""})`
          : `${error ?? "failed"} (backing off)`,
        ms: fetchedAt - classStarted,
      });
    }

    if (Date.now() - lastFlush >= FLUSH_EVERY_MS) await flush();
  };

  // Keep up to `limit` classes in flight, re-reading the limit as it adapts.
  // JS is single-threaded, so state/counter updates between awaits can't
  // interleave mid-update.
  const adaptTimer = setInterval(adapt, ADAPT_EVERY_MS);
  const running = new Set<Promise<void>>();
  let next = 0;
  while (next < queue.length && Date.now() < started + RUN_BUDGET_MS && !throttled) {
    if (running.size >= limit) {
      await Promise.race(running);
      continue;
    }
    const job: Promise<void> = processClass(queue[next++])
      .catch((error) => console.warn("class failed unexpectedly", error))
      .finally(() => running.delete(job));
    running.add(job);
  }
  await Promise.all(running);
  clearInterval(adaptTimer);
  if (throttled) limit = Math.max(CONCURRENCY_MIN, Math.floor(limit / 2));
  state.concurrency = limit;

  await flush();

  if (throttled) {
    state.pausedUntil = Date.now() + THROTTLE_PAUSE_MS;
    record({
      id: RUN_EVENT_ID,
      at: Date.now(),
      ok: false,
      error: `classes.berkeley.edu returned 429/503; pausing until ${new Date(state.pausedUntil).toISOString()}`,
      ms: Date.now() - started,
    });
  } else {
    delete state.pausedUntil;
  }
  state.errors = errors;
  const seconds = (Date.now() - started) / 1000;
  const summary: EnrollmentWorkerRunSummary = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    due: queue.length,
    fetched: ok,
    changed,
    failed,
    followerUpdates,
    requests,
    maxInFlight,
    requestsPerSecond: seconds ? Number((requests / seconds).toFixed(2)) : 0,
    throttled,
    concurrency: limit,
  };
  state.runs = [...(state.runs ?? []), summary].slice(-RUN_HISTORY);
  // Drop classes that left the manifest so state stays bounded.
  const ids = new Set(manifest.classes.map((c) => c.id));
  for (const id of Object.keys(state.classes)) {
    if (!ids.has(id)) delete state.classes[id];
  }
  await writeJsonGz(ENROLLMENT_WORKER_KEYS.state, state);

  clearInterval(liveTimer);
  finishedAt = Date.now();
  await writeLive();

  console.log(
    JSON.stringify({
      due: queue.length,
      backlog,
      newlySeen: seeded,
      fetched: ok,
      followers: followers.size,
      followerUpdates,
      timeoutRetries: retried,
      changed,
      failed,
      requests,
      maxInFlight,
      requestsPerSecond: seconds ? Number((requests / seconds).toFixed(2)) : 0,
      throttled,
      seconds: Number(seconds.toFixed(1)),
    })
  );
};
