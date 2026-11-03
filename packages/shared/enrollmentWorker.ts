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
  /**
   * Fetched only after every other due class, on the slow independent-study
   * interval. Tutorials, supervised research, and other one-section-per-sponsor
   * listings.
   */
  lowest?: boolean;
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

/**
 * Independent study / research / field study / individual exam prep (99, 197,
 * 199, 299, 399, 499, 601, 602, incl. variants like H199 or 299A): one section
 * per instructor. The datapuller leaves these out of the manifest; the worker
 * also treats any that slip in as lowest priority.
 */
export const INDEPENDENT_STUDY_NUMBERS =
  /^[A-Z]*(99|197|199|299|399|499|601|602)[A-Z]?$/;

export const isIndependentStudyNumber = (courseNumber: string) =>
  INDEPENDENT_STUDY_NUMBERS.test(courseNumber.toUpperCase());

/**
 * Graduate group study (298) and supervised teaching (300). Departments list
 * one section per faculty, the same shape as independent study.
 */
export const MASS_INDIVIDUAL_NUMBERS = /^(298|300)[A-Z]?$/;

/**
 * Reading & composition and directed group study (98/198, including 198BC)
 * are real classes students enroll in, even when a department offers many
 * sections. They stay on the normal schedule.
 */
const READING_COMPOSITION_NUMBERS = /^R[145][AB]$/;
const DIRECTED_GROUP_STUDY_NUMBERS = /^(98|198)[A-Z]*$/;

/** Components that, in bulk, are one section per sponsor rather than a course. */
const MASS_SECTION_COMPONENTS = new Set(["SEM", "COL", "GRP", "TUT"]);
/** One subject+number with at least this many of those sections is shelved. */
const MASS_SECTION_COUNT = 20;

/** Refresh bounds for individual instruction and other bulk section shells. */
export const INDEPENDENT_STUDY_TIER = {
  tier: "Lowest: tutorial, supervised research, group study",
  minIntervalSec: 24 * 60 * 60,
  maxIntervalSec: 7 * 24 * 60 * 60,
} as const;

const componentFromCatalogUrl = (url: string | undefined) =>
  url?.match(/-([a-z]{2,3})-[^-]+$/i)?.[1].toUpperCase();

/**
 * Apply the lowest tier to individual instruction and to courses listed as
 * dozens of near-duplicate sections (UGIS 192 tutorials, 298 group study,
 * research-review seminars, supervised teaching).
 */
export const withIndependentStudyLowest = (
  classes: EnrollmentWorkerClass[]
): (EnrollmentWorkerClass & { lowest?: boolean })[] => {
  const parsed = classes.map((c) => ({
    c,
    key: decodeEnrollmentWorkerClassId(c.id),
    component: componentFromCatalogUrl(c.urls[0]),
  }));
  const massCounts = new Map<string, number>();
  for (const { key, component } of parsed) {
    if (!key || !component || !MASS_SECTION_COMPONENTS.has(component)) continue;
    const courseNumber = key.courseNumber.toUpperCase();
    if (
      READING_COMPOSITION_NUMBERS.test(courseNumber) ||
      DIRECTED_GROUP_STUDY_NUMBERS.test(courseNumber)
    ) {
      continue;
    }
    const id = `${key.subject}|${courseNumber}`;
    massCounts.set(id, (massCounts.get(id) ?? 0) + 1);
  }
  return parsed.map(({ c, key, component }) => {
    if (!key) return c;
    const courseNumber = key.courseNumber.toUpperCase();
    const individual =
      isIndependentStudyNumber(courseNumber) ||
      component === "TUT" ||
      MASS_INDIVIDUAL_NUMBERS.test(courseNumber);
    const mass =
      (massCounts.get(`${key.subject}|${courseNumber}`) ?? 0) >=
      MASS_SECTION_COUNT;
    return individual || mass
      ? { ...c, ...INDEPENDENT_STUDY_TIER, lowest: true }
      : c;
  });
};
