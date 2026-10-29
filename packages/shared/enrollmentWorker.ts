import type { ParsedUcbCatalogEnrollment } from "./ucbCatalogEnrollment";

/**
 * Contract between the datapuller (which knows the catalog) and the AWS
 * enrollment worker (which polls classes.berkeley.edu). The datapuller
 * publishes a manifest of classes with per-class refresh bounds; the worker
 * writes batches of scraped enrollment that the datapuller imports.
 *
 * S3 layout:
 *   manifest/current.json.gz      datapuller -> worker
 *   state/scheduler.json.gz       worker-private scheduling state
 *   results/<ISO time>.json.gz    worker -> datapuller (expire after 3 days)
 *   status/live.json              worker -> status dashboard
 */
export const ENROLLMENT_WORKER_KEYS = {
  manifest: "manifest/current.json.gz",
  state: "state/scheduler.json.gz",
  resultsPrefix: "results/",
  /** Live run status for the dashboard (rewritten every few seconds). */
  liveStatus: "status/live.json",
} as const;

export type EnrollmentWorkerClass = {
  /** See encodeEnrollmentWorkerClassId. */
  id: string;
  /** Catalog URLs to try in order (primary listing, then cross-listings). */
  urls: string[];
  /** Dashboard label for the priority group this class is in. */
  tier?: string;
  /**
   * Whether the class has labs/discussions worth fetching from the
   * associated-sections page (default true). Skipping it halves the requests
   * for lecture-only classes.
   */
  associated?: boolean;
  /** Fastest refresh allowed (popular classes get a small value). */
  minIntervalSec: number;
  /** Slowest refresh once a class has stopped changing. */
  maxIntervalSec: number;
};

export type EnrollmentWorkerManifest = {
  version: 1;
  generatedAt: string;
  classes: EnrollmentWorkerClass[];
};

export type EnrollmentWorkerResult = {
  id: string;
  /**
   * Cross-listings whose own page is blank and that take their numbers from
   * this class's page; apply the same data to each.
   */
  alsoIds?: string[];
  /**
   * When classes.berkeley.edu generated the page (Last-Modified), i.e. the
   * time the numbers are actually from. May trail fetchedAt by up to the
   * CDN's 15-minute cache. Use this as the enrollment timestamp.
   */
  observedAt: string;
  /** When the worker received the page (diagnostics only). */
  fetchedAt: string;
  data: ParsedUcbCatalogEnrollment;
};

export type EnrollmentWorkerBatch = {
  version: 1;
  writtenAt: string;
  results: EnrollmentWorkerResult[];
};

export type EnrollmentWorkerClassKey = {
  year: number;
  semester: string;
  sessionId: string;
  subject: string;
  courseNumber: string;
  number: string;
};

export const encodeEnrollmentWorkerClassId = (key: EnrollmentWorkerClassKey) =>
  [
    key.year,
    key.semester,
    key.sessionId,
    key.subject,
    key.courseNumber,
    key.number,
  ].join("|");

export const decodeEnrollmentWorkerClassId = (
  id: string
): EnrollmentWorkerClassKey | null => {
  const parts = id.split("|");
  if (parts.length !== 6) return null;
  const [year, semester, sessionId, subject, courseNumber, number] = parts;
  return {
    year: Number(year),
    semester,
    sessionId,
    subject,
    courseNumber,
    number,
  };
};

export type EnrollmentWorkerRunSummary = {
  startedAt: string;
  finishedAt: string;
  due: number;
  fetched: number;
  changed: number;
  failed: number;
  followerUpdates: number;
  requests: number;
  maxInFlight: number;
  requestsPerSecond: number;
  throttled: boolean;
  /** Concurrency limit at the end of the run (adaptive). */
  concurrency?: number;
};

export type EnrollmentWorkerFetchEvent = {
  id: string;
  /** Page that served the numbers (or the first page tried, on failure). */
  url?: string;
  /** Epoch ms the worker finished this class. */
  at: number;
  ok: boolean;
  /** Page generation time (ok only). */
  observedAt?: number;
  enrolled?: number;
  max?: number;
  waitlisted?: number;
  changed?: boolean;
  followers?: number;
  error?: string;
  ms: number;
};

/** Written by the worker every few seconds while it runs. */
export type EnrollmentWorkerLiveStatus = {
  version: 1;
  updatedAt: number;
  run: {
    state: "running" | "finished" | "paused" | "idle";
    startedAt: number;
    budgetEndsAt: number;
    finishedAt: number | null;
    pausedUntil: number | null;
    due: number;
    fetched: number;
    changed: number;
    failed: number;
    requests: number;
    concurrency: number;
    maxRequestsPerSecond: number;
  };
  inFlight: { id: string; url: string; startedAt: number; timeoutMs: number }[];
  /** Newest first. */
  recent: EnrollmentWorkerFetchEvent[];
  /** Failures and throttling, newest first, kept across runs. */
  errors: EnrollmentWorkerFetchEvent[];
};
