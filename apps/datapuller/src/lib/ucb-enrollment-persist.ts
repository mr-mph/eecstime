/**
 * Persist a classes.berkeley.edu enrollment scrape into Mongo: enrollment
 * history for the primary section, its associated (lab/discussion) sections
 * and 0/0 combinedSections siblings. Returns catalog_classes patches for
 * updateCatalogEnrollment. Shared by the local ucb-catalog-enrollments puller
 * and the AWS enrollment worker importer.
 */
import {
  ISectionItem,
  NewEnrollmentHistoryModel,
  SectionModel,
} from "@repo/common/models";
import { ParsedUcbCatalogEnrollment, ParsedUcbEnrollment } from "@repo/shared";

import { isSectionEnrollmentBlankInDb } from "./crosslisting-enrollment-fanout";
import {
  buildActiveSeatReservations,
  mergeSeatReservationTypes,
  preserveRemovedSeatReservationCounts,
  seatReservationCountsEqual,
} from "./enrollment-utils";

const GRANULARITY_SECONDS = 60;
const PERSIST_VERSION_RETRIES = 5;

const enrollmentCountsEqual = (
  a: {
    status?: string;
    enrolledCount?: number;
    reservedCount?: number;
    waitlistedCount?: number;
    maxEnroll?: number;
    maxWaitlist?: number;
    openReserved?: number;
    seatReservationCount?: {
      number?: number;
      maxEnroll?: number;
      enrolledCount?: number;
    }[];
  },
  b: {
    status?: string;
    enrolledCount?: number;
    reservedCount?: number;
    waitlistedCount?: number;
    maxEnroll?: number;
    maxWaitlist?: number;
    openReserved?: number;
    seatReservationCount?: {
      number?: number;
      maxEnroll?: number;
      enrolledCount?: number;
    }[];
  }
) =>
  a.status === b.status &&
  a.enrolledCount === b.enrolledCount &&
  a.reservedCount === b.reservedCount &&
  a.waitlistedCount === b.waitlistedCount &&
  a.maxEnroll === b.maxEnroll &&
  a.maxWaitlist === b.maxWaitlist &&
  a.openReserved === b.openReserved &&
  seatReservationCountsEqual(a.seatReservationCount, b.seatReservationCount);

export type CatalogEnrollmentPatch = {
  status?: string;
  enrolledCount?: number;
  maxEnroll?: number;
  waitlistedCount?: number;
  maxWaitlist?: number;
  activeReservedMaxCount?: number;
  seatReservations?: {
    description: string;
    enrolledCount: number;
    maxEnroll: number;
  }[];
  enrollmentUpdatedAt?: Date;
};

const persistScrapedSectionEnrollment = async (
  year: number,
  semester: string,
  section: ISectionItem,
  scraped: ParsedUcbEnrollment,
  now: Date
): Promise<{ sectionId: string; patch: CatalogEnrollmentPatch } | null> => {
  const historyPoint = {
    startTime: now,
    endTime: now,
    granularitySeconds: GRANULARITY_SECONDS,
    status: scraped.status,
    enrolledCount: scraped.enrolledCount,
    reservedCount: scraped.reservedCount,
    waitlistedCount: scraped.waitlistedCount,
    minEnroll: scraped.minEnroll,
    maxEnroll: scraped.maxEnroll,
    maxWaitlist: scraped.maxWaitlist,
    openReserved: scraped.openReserved,
    instructorAddConsentRequired: scraped.instructorAddConsentRequired,
    instructorDropConsentRequired: scraped.instructorDropConsentRequired,
    seatReservationCount: scraped.seatReservationCount,
  };

  let seatReservationTypes = scraped.seatReservationTypes;
  let lastError: unknown;

  for (let attempt = 0; attempt < PERSIST_VERSION_RETRIES; attempt++) {
    try {
      let enrollmentDoc = await NewEnrollmentHistoryModel.findOne({
        year,
        semester,
        sessionId: section.sessionId,
        subject: section.subject,
        courseNumber: section.courseNumber,
        sectionNumber: section.number,
      });

      if (!enrollmentDoc) {
        enrollmentDoc = await NewEnrollmentHistoryModel.findOne({
          termId: section.termId,
          sessionId: section.sessionId,
          sectionId: section.sectionId,
        });
      }

      if (!enrollmentDoc) {
        enrollmentDoc = await NewEnrollmentHistoryModel.create({
          termId: section.termId,
          year,
          semester,
          sessionId: section.sessionId,
          sectionId: section.sectionId,
          subject: section.subject,
          courseNumber: section.courseNumber,
          sectionNumber: section.number,
          history: [historyPoint],
          seatReservationTypes: scraped.seatReservationTypes,
        });
      } else {
        const history = enrollmentDoc.history ?? [];
        const lastEntry = history[history.length - 1];

        // Snapshots can arrive late (CDN-cached pages, batched imports) or
        // interleave with the in-app refresh button. History must stay in time
        // order, so ignore anything not newer than what's already recorded.
        if (
          lastEntry?.endTime &&
          now.getTime() <= new Date(lastEntry.endTime).getTime()
        ) {
          return null;
        }

        historyPoint.seatReservationCount =
          preserveRemovedSeatReservationCounts(
            scraped.seatReservationCount,
            lastEntry?.seatReservationCount
          );

        if (
          lastEntry &&
          enrollmentCountsEqual(lastEntry, historyPoint) &&
          lastEntry.granularitySeconds === GRANULARITY_SECONDS
        ) {
          lastEntry.endTime = now;
          enrollmentDoc.markModified("history");
        } else {
          enrollmentDoc.history = [...history, historyPoint];
        }

        if (scraped.seatReservationTypes.length > 0) {
          enrollmentDoc.seatReservationTypes = mergeSeatReservationTypes(
            enrollmentDoc.seatReservationTypes,
            scraped.seatReservationTypes
          );
        }

        await enrollmentDoc.save();
      }

      seatReservationTypes = enrollmentDoc.seatReservationTypes ?? [];
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const isVersionError =
        error instanceof Error &&
        (error.name === "VersionError" ||
          /No matching document found for id/.test(error.message));
      if (!isVersionError || attempt === PERSIST_VERSION_RETRIES - 1) {
        throw error;
      }
    }
  }

  if (lastError) throw lastError;

  const seatReservations = buildActiveSeatReservations(
    historyPoint.seatReservationCount,
    seatReservationTypes
  );
  const activeReservedMaxCount = seatReservations.reduce(
    (sum, reservation) => sum + reservation.maxEnroll,
    0
  );

  return {
    sectionId: section.sectionId,
    patch: {
      status: historyPoint.status,
      enrolledCount: historyPoint.enrolledCount,
      maxEnroll: historyPoint.maxEnroll,
      waitlistedCount: historyPoint.waitlistedCount,
      maxWaitlist: historyPoint.maxWaitlist,
      activeReservedMaxCount: section.primary
        ? activeReservedMaxCount
        : undefined,
      seatReservations: section.primary ? seatReservations : undefined,
      enrollmentUpdatedAt: now,
    },
  };
};

export const findCombinedSiblingSections = async (
  section: ISectionItem
): Promise<ISectionItem[]> => {
  const combinedIds = (section.combinedSections ?? [])
    .map(String)
    .filter((id) => id !== String(section.sectionId));
  if (combinedIds.length === 0) return [];

  return (await SectionModel.find({
    year: section.year,
    semester: section.semester,
    sessionId: section.sessionId,
    sectionId: { $in: combinedIds },
  }).lean()) as ISectionItem[];
};

const matchAssociatedScrapedEnrollment = (
  section: ISectionItem,
  associatedBySectionId: Map<string, ParsedUcbEnrollment>,
  associatedByNumber: Map<string, ParsedUcbEnrollment>
): ParsedUcbEnrollment | undefined => {
  const byId = associatedBySectionId.get(section.sectionId);
  if (byId) return byId;

  const byNumber = associatedByNumber.get(section.number);
  if (byNumber) return byNumber;

  for (const combinedId of section.combinedSections ?? []) {
    const byCombined = associatedBySectionId.get(String(combinedId));
    if (byCombined) return byCombined;
  }

  return undefined;
};

const isSiblingCatalogBlank = async (
  section: ISectionItem
): Promise<boolean | null> => {
  // Use stored enrollment (data-source agnostic) instead of re-fetching
  // classes.berkeley.edu for every combinedSections sibling.
  try {
    return await isSectionEnrollmentBlankInDb(section);
  } catch {
    return null;
  }
};

/**
 * Persist enrollment to a section, and fan out only to combinedSections siblings
 * whose own classes.berkeley.edu page is blank (0/0). SIS may put separately
 * enrolled lectures (e.g. DATA C8 LEC 001 + 002) in the same combination — those
 * with real seat counts must not be overwritten.
 */
const persistScrapedSectionEnrollmentWithFanOut = async (
  year: number,
  semester: string,
  section: ISectionItem,
  scraped: ParsedUcbEnrollment,
  now: Date
): Promise<Array<{ sectionId: string; patch: CatalogEnrollmentPatch }>> => {
  const siblings = await findCombinedSiblingSections(section);
  const targets: ISectionItem[] = [section];
  const seen = new Set<string>([section.sectionId]);

  for (const sibling of siblings) {
    if (seen.has(sibling.sectionId)) continue;
    seen.add(sibling.sectionId);

    const blank = await isSiblingCatalogBlank(sibling);
    if (blank !== true) continue;

    targets.push(sibling);
  }

  const results: Array<{ sectionId: string; patch: CatalogEnrollmentPatch }> =
    [];
  for (const target of targets) {
    const result = await persistScrapedSectionEnrollment(
      year,
      semester,
      target,
      scraped,
      now
    );
    if (result) results.push(result);
  }

  return results;
};

export type SectionPatch = { sectionId: string; patch: CatalogEnrollmentPatch };

/**
 * Persist one class's scrape (primary + associated sections). `signal` lets a
 * caller with a timeout stop between writes.
 */
export const persistScrapedClassEnrollment = async (
  catalogClass: {
    year: number;
    semester: string;
    sessionId: string;
    subject: string;
    courseNumber: string;
  },
  primarySection: ISectionItem,
  scraped: ParsedUcbCatalogEnrollment,
  signal: { aborted: boolean } = { aborted: false },
  now = new Date()
): Promise<SectionPatch[]> => {
  const patches: SectionPatch[] = [];

  patches.push(
    ...(await persistScrapedSectionEnrollmentWithFanOut(
      catalogClass.year,
      catalogClass.semester,
      primarySection,
      scraped.primary,
      now
    ))
  );

  if (signal.aborted) return patches;

  if (scraped.associatedSections.length > 0) {
    const associatedBySectionId = new Map(
      scraped.associatedSections.map((section) => [
        section.sectionId,
        section,
      ])
    );
    const associatedByNumber = new Map(
      scraped.associatedSections
        .filter((section) => section.sectionNumber)
        .map((section) => [section.sectionNumber!, section])
    );
    const scrapedSectionIds = scraped.associatedSections.map(
      (section) => section.sectionId
    );
    const scrapedSectionIdNums = scrapedSectionIds
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));

    const associatedSections = await SectionModel.find({
      year: catalogClass.year,
      semester: catalogClass.semester,
      sessionId: catalogClass.sessionId,
      subject: catalogClass.subject,
      courseNumber: catalogClass.courseNumber,
      primary: false,
      $or: [
        { sectionId: { $in: scrapedSectionIds } },
        { number: { $in: [...associatedByNumber.keys()] } },
        ...(scrapedSectionIdNums.length > 0
          ? [{ combinedSections: { $in: scrapedSectionIdNums } }]
          : []),
      ],
    }).lean();

    const seenAssociated = new Set<string>();
    for (const section of associatedSections) {
      if (signal.aborted) return patches;
      const match = matchAssociatedScrapedEnrollment(
        section as ISectionItem,
        associatedBySectionId,
        associatedByNumber
      );
      if (!match || seenAssociated.has(section.sectionId)) continue;
      seenAssociated.add(section.sectionId);

      const fanOutPatches = await persistScrapedSectionEnrollmentWithFanOut(
        catalogClass.year,
        catalogClass.semester,
        section as ISectionItem,
        match,
        now
      );
      for (const patch of fanOutPatches) {
        seenAssociated.add(patch.sectionId);
        patches.push(patch);
      }
    }
  }

  return patches;
};
