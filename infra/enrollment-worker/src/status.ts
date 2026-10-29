/**
 * Read-only status dashboard for the enrollment worker, served from a Lambda
 * function URL. Separate from the worker so loading it can never start a
 * scrape.
 *
 *   GET /             the dashboard page (polls /api/status)
 *   GET /api/status   JSON: live run + freshness summary + recent runs
 */
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { gunzipSync } from "node:zlib";

import {
  ENROLLMENT_WORKER_KEYS,
  type EnrollmentWorkerLiveStatus,
  type EnrollmentWorkerManifest,
  type EnrollmentWorkerRunSummary,
  withIndependentStudyLowest,
} from "../../../packages/shared/enrollmentWorker";
import { DASHBOARD_HTML } from "./status-page";

const BUCKET = process.env.BUCKET ?? "";
const SUMMARY_TTL_MS = 30_000;
const FOLLOWER_RECHECK_MS = 24 * 60 * 60_000;
const s3 = new S3Client({});

type ClassState = {
  last: number;
  intervalSec: number;
  hash?: string;
  okAt?: number;
  via?: string;
  viaCheckedAt?: number;
  retryTimeoutMs?: number;
};
type SchedulerState = {
  classes: Record<string, ClassState>;
  runs?: EnrollmentWorkerRunSummary[];
  pausedUntil?: number;
};

const readObject = async (key: string, gz: boolean) => {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return JSON.parse((gz ? gunzipSync(bytes) : Buffer.from(bytes)).toString("utf8"));
  } catch (error) {
    if (error instanceof NoSuchKey) return null;
    throw error;
  }
};

/** "2026|Fall|1|COMPSCI|61A|001" -> "Fall 2026 COMPSCI 61A 001" */
export const classLabel = (id: string) => {
  const [year, semester, , subject, courseNumber, number] = id.split("|");
  return `${semester} ${year} ${subject} ${courseNumber} ${number}`;
};

const span = (sec: number) => (sec < 3600 ? `${sec / 60} min` : `${sec / 3600} h`);
/** Manifest tier label plus its refresh bounds, e.g. "... (15 min – 2 h)". */
const tierLabel = (c: { tier?: string; minIntervalSec: number; maxIntervalSec: number }) =>
  `${c.tier ?? "Classes"} (${span(c.minIntervalSec)} – ${span(c.maxIntervalSec)})`;

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

let cachedSummary: { at: number; value: unknown } | null = null;
/** Class id -> its own catalog page, for events recorded without a URL. */
let pageById = new Map<string, string>();

const buildSummary = async () => {
  if (cachedSummary && Date.now() - cachedSummary.at < SUMMARY_TTL_MS) {
    return cachedSummary.value;
  }
  const [manifest, state] = (await Promise.all([
    readObject(ENROLLMENT_WORKER_KEYS.manifest, true),
    readObject(ENROLLMENT_WORKER_KEYS.state, true),
  ])) as [EnrollmentWorkerManifest | null, SchedulerState | null];
  const now = Date.now();
  const classes = withIndependentStudyLowest(manifest?.classes ?? []);
  pageById = new Map(classes.map((c) => [c.id, c.urls[0]]));
  const states = state?.classes ?? {};

  const windows = [
    { label: "15 min", ms: 15 * 60_000 },
    { label: "1 hour", ms: 60 * 60_000 },
    { label: "6 hours", ms: 6 * 60 * 60_000 },
    { label: "24 hours", ms: 24 * 60 * 60_000 },
  ];
  const updatedWithin = windows.map((w) => ({ ...w, count: 0 }));
  let neverFetched = 0;
  let followers = 0;
  let retryPending = 0;
  type Tier = {
    name: string;
    minIntervalSec: number;
    total: number;
    fetched: number;
    ages: number[];
    overdue: number;
  };
  const tiers = new Map<string, Tier>();

  for (const c of classes) {
    const s = states[c.id];
    const okAt = s?.okAt ?? (s?.hash ? s.last : undefined);
    const tierName = tierLabel(c);
    const tier =
      tiers.get(tierName) ??
      { name: tierName, minIntervalSec: c.minIntervalSec, total: 0, fetched: 0, ages: [], overdue: 0 };
    tier.total += 1;
    if (okAt) {
      const age = now - okAt;
      tier.fetched += 1;
      tier.ages.push(age);
      // Past its slowest refresh: the budget isn't keeping up.
      if (age > c.maxIntervalSec * 1000) tier.overdue += 1;
      for (const w of updatedWithin) if (age <= w.ms) w.count += 1;
    } else {
      neverFetched += 1;
    }
    tiers.set(tierName, tier);
    if (s?.via && s.viaCheckedAt && now - s.viaCheckedAt <= FOLLOWER_RECHECK_MS) followers += 1;
    if (s?.retryTimeoutMs) retryPending += 1;
  }

  const value = {
    manifestGeneratedAt: manifest?.generatedAt ?? null,
    totalClasses: classes.length,
    neverFetched,
    followers,
    retryPending,
    updatedWithin: updatedWithin.map(({ label, count }) => ({ label, count })),
    tiers: [...tiers.values()]
      .sort((a, b) => a.minIntervalSec - b.minIntervalSec || a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        total: t.total,
        fetched: t.fetched,
        overdue: t.overdue,
        medianAgeMs: median(t.ages),
      })),
    runs: [...(state?.runs ?? [])].reverse().slice(0, 12),
    pausedUntil: state?.pausedUntil ?? null,
  };
  cachedSummary = { at: Date.now(), value };
  return value;
};

type FunctionUrlEvent = { rawPath?: string; requestContext?: { http?: { method?: string } } };

export const handler = async (event: FunctionUrlEvent) => {
  const path = event.rawPath ?? "/";
  if (event.requestContext?.http?.method && event.requestContext.http.method !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  if (path === "/api/status") {
    const [live, summary] = await Promise.all([
      readObject(ENROLLMENT_WORKER_KEYS.liveStatus, false) as Promise<EnrollmentWorkerLiveStatus | null>,
      buildSummary(),
    ]);
    const label = (id: string) => classLabel(id);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        now: Date.now(),
        live: live && {
          ...live,
          inFlight: live.inFlight.map((f) => ({ ...f, label: label(f.id) })),
          recent: live.recent.map((r) => ({
            ...r,
            url: r.url ?? pageById.get(r.id),
            label: label(r.id),
          })),
          errors: (live.errors ?? []).map((r) => ({
            ...r,
            url: r.url ?? pageById.get(r.id),
            label: r.id === "run" ? "Whole run" : label(r.id),
          })),
        },
        summary,
      }),
    };
  }
  if (path === "/" || path === "/index.html") {
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: DASHBOARD_HTML,
    };
  }
  return { statusCode: 404, body: "Not found" };
};
