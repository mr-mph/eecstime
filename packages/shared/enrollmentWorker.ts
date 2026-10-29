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
 */
export const ENROLLMENT_WORKER_KEYS = {
  manifest: "manifest/current.json.gz",
  state: "state/scheduler.json.gz",
  resultsPrefix: "results/",
} as const;

export type EnrollmentWorkerClass = {
  /** See encodeEnrollmentWorkerClassId. */
  id: string;
  /** Catalog URLs to try in order (primary listing, then cross-listings). */
  urls: string[];
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
