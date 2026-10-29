import { parseTermName } from "@repo/common";
import {
  CatalogClassModel,
  ICatalogClassItem,
  ISectionItem,
  SectionModel,
  UCB_ENROLLMENT_SCRAPE_STATUS_KEY,
  UcbEnrollmentScrapeStatusModel,
  type UcbEnrollmentScrapeState,
} from "@repo/common/models";
import {
  UcbCatalogEnrollmentError,
  buildUcbCatalogUrl,
  fetchUcbCatalogEnrollment,
  isBlankUcbEnrollment,
} from "@repo/shared";

import { updateCatalogEnrollment } from "../lib/catalog-denormalize";
import {
  CatalogEnrollmentPatch,
  findCombinedSiblingSections,
  persistScrapedClassEnrollment,
} from "../lib/ucb-enrollment-persist";
import { Config } from "../shared/config";
import { getActiveTerms } from "../shared/term-selectors";

const CONCURRENCY = 4;
const CATALOG_FLUSH_EVERY = 50;
const PROGRESS_WRITE_EVERY = 5;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const USER_AGENT = "BerkeleytimeUcbEnrollmentPuller/1.0";
/** Skip classes scraped within this window so restarts don't re-query them. */
const RECENT_SCRAPE_TTL_MS = 45 * 60 * 1000;
/** Hard cap so one wedged class/fetch can't stall the whole pool forever. */
const CLASS_SCRAPE_TIMEOUT_MS = 120_000;
/** Don't walk unbounded combinedSections scrape candidates. */
const MAX_SCRAPE_CANDIDATES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ProgressUpdate = {
  state: UcbEnrollmentScrapeState;
  year?: number;
  semester?: string;
  total?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  currentLabel?: string | null;
  message?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

const writeScrapeProgress = async (update: ProgressUpdate) => {
  await UcbEnrollmentScrapeStatusModel.findOneAndUpdate(
    { key: UCB_ENROLLMENT_SCRAPE_STATUS_KEY },
    {
      $set: {
        key: UCB_ENROLLMENT_SCRAPE_STATUS_KEY,
        ...update,
      },
    },
    { upsert: true }
  );
};

const scrapeEnrollmentForSection = async (
  section: ISectionItem,
  log: Config["log"]
): Promise<Awaited<ReturnType<typeof fetchUcbCatalogEnrollment>> | null> => {
  if (!section.component) return null;
  const url = buildUcbCatalogUrl({
    year: section.year,
    semester: section.semester,
    subject: section.subject,
    courseNumber: section.courseNumber,
    number: section.number,
    component: section.component,
  });
  try {
    const scraped = await fetchWithRetry(url, log);
    if (isBlankUcbEnrollment(scraped.primary)) return null;
    return scraped;
  } catch {
    return null;
  }
};

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (/HTTP (429|403|5\d\d)/.test(message)) return true;
  if (error instanceof UcbCatalogEnrollmentError) {
    return error.code === "INTERNAL_SERVER_ERROR";
  }
  return /timeout|network|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
};

const fetchWithRetry = async (url: string, log: Config["log"]) => {
  let attempt = 0;
  while (true) {
    try {
      return await fetchUcbCatalogEnrollment(url, {
        userAgent: USER_AGENT,
      });
    } catch (error) {
      attempt += 1;
      if (!isRetryableError(error) || attempt > MAX_RETRIES) {
        throw error;
      }
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      log.warn(
        `Retry ${attempt}/${MAX_RETRIES} for ${url} after ${delay}ms: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      await sleep(delay);
    }
  }
};

const flushCatalogPatches = async (
  log: Config["log"],
  backendUrl: string,
  year: number,
  semester: string,
  catalogPatches: Map<string, CatalogEnrollmentPatch>
) => {
  if (catalogPatches.size === 0) return;
  const batch = new Map(catalogPatches);
  catalogPatches.clear();
  await updateCatalogEnrollment(log, year, semester, batch);
  // Let the scrape continue while the frontend/backend caches are cleared.
  void invalidateBackendCaches(backendUrl, log);
};

const invalidateBackendCaches = async (
  backendUrl: string,
  log: Config["log"]
) => {
  const url = new URL("/api/cache/invalidate-catalog", backendUrl);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      log.warn(
        `Cache invalidate returned HTTP ${response.status} from ${url.href}`
      );
      return;
    }
    log.info(`Invalidated backend catalog caches via ${url.href}`);
  } catch (error) {
    log.warn(
      `Failed to invalidate backend caches: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
};

type CatalogClassTarget = Pick<
  ICatalogClassItem,
  | "year"
  | "semester"
  | "termId"
  | "sessionId"
  | "subject"
  | "courseNumber"
  | "number"
  | "primarySectionId"
  | "primaryComponent"
  | "berkeleytimeRatingCount"
  | "enrollmentUpdatedAt"
>;

const runPool = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) => {
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
};

const scrapeTerm = async (config: Config, year: number, semester: string) => {
  const log = config.log.getSubLogger({
    name: `UcbCatalogEnrollments:${year}${semester}`,
  });

  const allClasses = (await CatalogClassModel.find({ year, semester })
    .select({
      year: 1,
      semester: 1,
      termId: 1,
      sessionId: 1,
      subject: 1,
      courseNumber: 1,
      number: 1,
      primarySectionId: 1,
      primaryComponent: 1,
      berkeleytimeRatingCount: 1,
      enrollmentUpdatedAt: 1,
    })
    .sort({
      berkeleytimeRatingCount: -1,
      subject: 1,
      courseNumber: 1,
      number: 1,
    })
    .lean()) as CatalogClassTarget[];

  const recentCutoff = Date.now() - RECENT_SCRAPE_TTL_MS;
  const classes = allClasses.filter((catalogClass) => {
    if (!catalogClass.enrollmentUpdatedAt) return true;
    return new Date(catalogClass.enrollmentUpdatedAt).getTime() < recentCutoff;
  });
  const alreadyFresh = allClasses.length - classes.length;

  log.info(
    `Scraping ${classes.length.toLocaleString()} of ${allClasses.length.toLocaleString()} catalog classes ordered by berkeleytimeRatingCount` +
      (alreadyFresh > 0
        ? ` (skipping ${alreadyFresh.toLocaleString()} scraped within ${Math.round(RECENT_SCRAPE_TTL_MS / 60000)}m)`
        : "")
  );

  if (classes.length === 0) {
    await writeScrapeProgress({
      state: "completed",
      year,
      semester,
      total: allClasses.length,
      processed: allClasses.length,
      succeeded: alreadyFresh,
      failed: 0,
      skipped: 0,
      currentLabel: null,
      message: `All ${semester} ${year} classes already scraped recently`,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    return;
  }

  await writeScrapeProgress({
    state: "running",
    year,
    semester,
    total: classes.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    currentLabel: null,
    message:
      alreadyFresh > 0
        ? `Resuming ${semester} ${year} (${alreadyFresh.toLocaleString()} already fresh)`
        : `Scraping ${semester} ${year}`,
    startedAt: new Date(),
    finishedAt: null,
  });

  const catalogPatches = new Map<string, CatalogEnrollmentPatch>();
  let patchMutex: Promise<void> = Promise.resolve();
  const withPatchLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = patchMutex;
    let release!: () => void;
    patchMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;
  let processedSinceFlush = 0;
  let processedSinceProgress = 0;

  const bumpProgress = async (
    currentLabel: string | null,
    kind: "success" | "fail" | "skip"
  ) => {
    await withPatchLock(async () => {
      if (kind === "success") succeeded += 1;
      if (kind === "fail") failed += 1;
      if (kind === "skip") skipped += 1;
      processed += 1;
      processedSinceProgress += 1;

      const shouldWrite =
        processedSinceProgress >= PROGRESS_WRITE_EVERY ||
        processed >= classes.length;

      if (!shouldWrite) return;

      processedSinceProgress = 0;
      await writeScrapeProgress({
        state: "running",
        year,
        semester,
        total: classes.length,
        processed,
        succeeded,
        failed,
        skipped,
        currentLabel,
        message: `Scraping ${semester} ${year}`,
      });
    });
  };

  await runPool(classes, CONCURRENCY, async (catalogClass, index) => {
    const label = `${catalogClass.subject} ${catalogClass.courseNumber} ${catalogClass.number}`;

    if (!catalogClass.primaryComponent || !catalogClass.primarySectionId) {
      await bumpProgress(label, "skip");
      return;
    }

    const primarySection = await SectionModel.findOne({
      year: catalogClass.year,
      semester: catalogClass.semester,
      sessionId: catalogClass.sessionId,
      subject: catalogClass.subject,
      courseNumber: catalogClass.courseNumber,
      number: catalogClass.number,
      primary: true,
    }).lean();

    if (!primarySection?.sectionId || !primarySection.component) {
      await bumpProgress(label, "skip");
      return;
    }

    const combinedSiblings = await findCombinedSiblingSections(
      primarySection as ISectionItem
    );
    const scrapeCandidates = [
      primarySection as ISectionItem,
      ...combinedSiblings,
    ].slice(0, MAX_SCRAPE_CANDIDATES);

    const scrapeAndPersist = async (signal: { aborted: boolean }) => {
      let scraped: Awaited<ReturnType<typeof fetchUcbCatalogEnrollment>> | null =
        null;

      for (const candidate of scrapeCandidates) {
        if (signal.aborted) return;
        scraped = await scrapeEnrollmentForSection(candidate, log);
        if (scraped) {
          if (candidate.sectionId !== primarySection.sectionId) {
            log.info(
              `Using cross-listed enrollment from ${candidate.subject} ${candidate.courseNumber} ${candidate.number} for ${label}`
            );
          }
          break;
        }
      }

      if (signal.aborted) return;

      if (!scraped) {
        await bumpProgress(label, "fail");
        log.warn(
          `Failed ${label}: no usable enrollment on this listing or combinedSections siblings`
        );
        return;
      }

      const patches = await persistScrapedClassEnrollment(
        catalogClass,
        primarySection as ISectionItem,
        scraped,
        signal
      );

      if (signal.aborted) return;

      await withPatchLock(async () => {
        for (const { sectionId, patch } of patches) {
          catalogPatches.set(sectionId, patch);
        }
        processedSinceFlush += 1;

        if (processedSinceFlush >= CATALOG_FLUSH_EVERY) {
          processedSinceFlush = 0;
          await flushCatalogPatches(
            log,
            config.BACKEND_URL,
            catalogClass.year,
            catalogClass.semester,
            catalogPatches
          );
        }
      });

      if (signal.aborted) return;

      await bumpProgress(label, "success");

      if ((index + 1) % 100 === 0 || index === classes.length - 1) {
        log.info(
          `Progress ${index + 1}/${classes.length} (ok=${succeeded}, fail=${failed}, skip=${skipped}) last=${label}`
        );
      }
    };

    const signal = { aborted: false };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        scrapeAndPersist(signal),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            signal.aborted = true;
            reject(
              new Error(
                `Timed out after ${CLASS_SCRAPE_TIMEOUT_MS}ms scraping ${label}`
              )
            );
          }, CLASS_SCRAPE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      signal.aborted = true;
      await bumpProgress(label, "fail");
      log.warn(
        `Failed ${label}: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  });

  await withPatchLock(async () => {
    await flushCatalogPatches(
      log,
      config.BACKEND_URL,
      year,
      semester,
      catalogPatches
    );
  });

  await writeScrapeProgress({
    state: "running",
    year,
    semester,
    total: classes.length,
    processed,
    succeeded,
    failed,
    skipped,
    currentLabel: null,
    message: `Finished ${semester} ${year}`,
  });

  log.info(
    `Finished ${year} ${semester}: ok=${succeeded}, fail=${failed}, skip=${skipped}`
  );
};

const SEMESTER_ORDER: Record<string, number> = {
  Spring: 1,
  Summer: 2,
  Fall: 3,
};

export const syncUcbCatalogEnrollments = async (config: Config) => {
  const log = config.log.getSubLogger({ name: "UcbCatalogEnrollmentsPuller" });

  const terms = await getActiveTerms();

  const uniqueTerms = new Map<string, { year: number; semester: string }>();
  for (const term of terms) {
    const parsed = parseTermName(term.name);
    if (!parsed) continue;
    const key = `${parsed.year}:${parsed.semester}`;
    if (!uniqueTerms.has(key)) {
      uniqueTerms.set(key, parsed);
    }
  }

  // Only scrape the single current semester: the latest term (by year, then
  // Fall > Summer > Spring) that actually has catalog classes. This matches the
  // catalog's default term and skips empty future terms (e.g. Spring 2027).
  const termsWithCounts = await Promise.all(
    [...uniqueTerms.values()].map(async (term) => {
      const count = await CatalogClassModel.countDocuments({
        year: term.year,
        semester: term.semester,
      });
      return { ...term, count };
    })
  );

  const currentTerm = termsWithCounts
    .filter((term) => term.count > 0)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return (
        (SEMESTER_ORDER[b.semester] ?? 0) - (SEMESTER_ORDER[a.semester] ?? 0)
      );
    })[0];

  if (!currentTerm) {
    log.warn("No active terms with catalog data found; nothing to scrape");
    await writeScrapeProgress({
      state: "idle",
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      currentLabel: null,
      message: "No active terms found",
      finishedAt: new Date(),
    });
    return;
  }

  log.info(
    `Starting UCB catalog enrollment scrape for ${currentTerm.semester} ${currentTerm.year}`
  );

  try {
    await scrapeTerm(config, currentTerm.year, currentTerm.semester);

    await invalidateBackendCaches(config.BACKEND_URL, log);

    const latest = await UcbEnrollmentScrapeStatusModel.findOne({
      key: UCB_ENROLLMENT_SCRAPE_STATUS_KEY,
    }).lean();

    await writeScrapeProgress({
      state: "completed",
      year: latest?.year,
      semester: latest?.semester,
      total: latest?.total ?? 0,
      processed: latest?.processed ?? 0,
      succeeded: latest?.succeeded ?? 0,
      failed: latest?.failed ?? 0,
      skipped: latest?.skipped ?? 0,
      currentLabel: null,
      message: "Enrollment scrape complete",
      finishedAt: new Date(),
    });
  } catch (error) {
    await writeScrapeProgress({
      state: "failed",
      message:
        error instanceof Error ? error.message : "Enrollment scrape failed",
      finishedAt: new Date(),
    });
    throw error;
  }
};

export default {
  syncUcbCatalogEnrollments,
};
