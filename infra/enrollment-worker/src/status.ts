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

const TIER_NAMES: Record<number, string> = {
  900: "Top 100 (every 15 min)",
  1800: "Top 500 (every 30 min)",
  7200: "Top 2000 (every 2 h)",
  21600: "Everything else (every 6 h)",
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

let cachedSummary: { at: number; value: unknown } | null = null;

const buildSummary = async () => {
  if (cachedSummary && Date.now() - cachedSummary.at < SUMMARY_TTL_MS) {
    return cachedSummary.value;
  }
  const [manifest, state] = (await Promise.all([
    readObject(ENROLLMENT_WORKER_KEYS.manifest, true),
    readObject(ENROLLMENT_WORKER_KEYS.state, true),
  ])) as [EnrollmentWorkerManifest | null, SchedulerState | null];
  const now = Date.now();
  const classes = manifest?.classes ?? [];
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
  type Tier = { name: string; total: number; fetched: number; ages: number[]; overdue: number };
  const tiers = new Map<string, Tier>();

  for (const c of classes) {
    const s = states[c.id];
    const okAt = s?.okAt ?? (s?.hash ? s.last : undefined);
    const gated = c.maxIntervalSec >= 48 * 60 * 60;
    const tierName = gated
      ? "Grad / consent / no capacity (every 6 h+)"
      : (TIER_NAMES[c.minIntervalSec] ?? `every ${Math.round(c.minIntervalSec / 60)} min`);
    const tier = tiers.get(tierName) ?? { name: tierName, total: 0, fetched: 0, ages: [], overdue: 0 };
    tier.total += 1;
    if (okAt) {
      const age = now - okAt;
      tier.fetched += 1;
      tier.ages.push(age);
      if (age > 2 * c.minIntervalSec * 1000) tier.overdue += 1;
      for (const w of updatedWithin) if (age <= w.ms) w.count += 1;
    } else {
      neverFetched += 1;
    }
    tiers.set(tierName, tier);
    if (s?.via && s.viaCheckedAt && now - s.viaCheckedAt <= FOLLOWER_RECHECK_MS) followers += 1;
    if (s?.retryTimeoutMs) retryPending += 1;
  }

  const tierOrder = [...Object.values(TIER_NAMES), "Grad / consent / no capacity (every 6 h+)"];
  const value = {
    manifestGeneratedAt: manifest?.generatedAt ?? null,
    totalClasses: classes.length,
    neverFetched,
    followers,
    retryPending,
    updatedWithin: updatedWithin.map(({ label, count }) => ({ label, count })),
    tiers: [...tiers.values()]
      .sort((a, b) => tierOrder.indexOf(a.name) - tierOrder.indexOf(b.name))
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
          recent: live.recent.map((r) => ({ ...r, label: label(r.id) })),
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
