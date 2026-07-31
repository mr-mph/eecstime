import { GraphQLError } from "graphql";
import type { RedisClientType } from "redis";

import {
  CatalogClassModel,
  ISectionItem,
  NewEnrollmentHistoryModel,
  SectionModel,
} from "@repo/common/models";

import { Semester } from "../../generated-types/graphql";
import { invalidateApolloResponseCache } from "../../utils/cache";
import { buildSubjectQuery } from "../../utils/subject";
import { invalidateCatalogCache } from "../catalog/catalog-cache";
import { formatEnrollment } from "./formatter";
import {
  ParsedUcbEnrollment,
  buildUcbCatalogUrl,
  fetchUcbCatalogEnrollment,
  isBlankUcbEnrollment,
  mergeSeatReservationTypes,
  preserveRemovedSeatReservationCounts,
  seatReservationCountsEqual,
} from "./ucbCatalogEnrollment";

const MANUAL_REFRESH_GRANULARITY_SECONDS = 60;

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

const persistScrapedSectionEnrollment = async (
  year: number,
  semester: Semester,
  section: ISectionItem,
  scraped: ParsedUcbEnrollment,
  now: Date
) => {
  const historyPoint = {
    startTime: now,
    endTime: now,
    granularitySeconds: MANUAL_REFRESH_GRANULARITY_SECONDS,
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

    historyPoint.seatReservationCount = preserveRemovedSeatReservationCounts(
      scraped.seatReservationCount,
      lastEntry?.seatReservationCount
    );

    if (
      lastEntry &&
      enrollmentCountsEqual(lastEntry, historyPoint) &&
      lastEntry.granularitySeconds === MANUAL_REFRESH_GRANULARITY_SECONDS
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

  const seatReservations = (() => {
    const counts = historyPoint.seatReservationCount ?? [];
    const types = enrollmentDoc.seatReservationTypes ?? [];
    const nowDate = now;
    const result: {
      description: string;
      enrolledCount: number;
      maxEnroll: number;
    }[] = [];
    for (const reservation of counts) {
      const maxEnroll = reservation.maxEnroll ?? 0;
      const matchingType = types.find(
        (type) => type.number === reservation.number
      );
      const fromDate = matchingType?.fromDate ?? "";
      const fromDateObj = fromDate ? new Date(fromDate) : null;
      const hasValidFromDate =
        fromDateObj !== null && !Number.isNaN(fromDateObj.getTime());
      const isActive =
        maxEnroll > 1 &&
        (!hasValidFromDate || (fromDateObj !== null && fromDateObj <= nowDate));
      if (!isActive) continue;
      result.push({
        description:
          matchingType?.requirementGroup?.description?.trim() || "Unknown",
        enrolledCount: reservation.enrolledCount ?? 0,
        maxEnroll,
      });
    }
    return result;
  })();
  const activeReservedMaxCount = seatReservations.reduce(
    (sum, reservation) => sum + reservation.maxEnroll,
    0
  );
  const openSeats = Math.max(
    0,
    (historyPoint.maxEnroll ?? 0) - (historyPoint.enrolledCount ?? 0)
  );

  if (section.primary) {
    await CatalogClassModel.updateMany(
      {
        year,
        semester,
        primarySectionId: section.sectionId,
      },
      {
        $set: {
          enrollmentStatus: historyPoint.status,
          enrolledCount: historyPoint.enrolledCount,
          maxEnroll: historyPoint.maxEnroll,
          waitlistedCount: historyPoint.waitlistedCount,
          maxWaitlist: historyPoint.maxWaitlist,
          activeReservedMaxCount,
          seatReservations,
          openSeats,
          enrollmentUpdatedAt: now,
        },
      }
    );
  }

  await CatalogClassModel.updateMany(
    {
      year,
      semester,
      "sections.sectionId": section.sectionId,
    },
    {
      $set: {
        "sections.$.enrollmentStatus": historyPoint.status,
        "sections.$.enrolledCount": historyPoint.enrolledCount,
        "sections.$.maxEnroll": historyPoint.maxEnroll,
        "sections.$.waitlistedCount": historyPoint.waitlistedCount,
        "sections.$.maxWaitlist": historyPoint.maxWaitlist,
      },
    }
  );

  return enrollmentDoc;
};

const findCombinedSiblingSections = async (
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

/**
 * True when the sibling's stored enrollment is blank (0/0) or missing.
 * Uses DB state so fan-out works for scrape, backup, and SIS sources alike.
 */
const isSiblingCatalogBlank = async (
  section: ISectionItem
): Promise<boolean | null> => {
  try {
    let enrollment = await NewEnrollmentHistoryModel.findOne({
      year: section.year,
      semester: section.semester,
      sessionId: section.sessionId,
      subject: section.subject,
      courseNumber: section.courseNumber,
      sectionNumber: section.number,
    }).lean();

    if (!enrollment) {
      enrollment = await NewEnrollmentHistoryModel.findOne({
        termId: section.termId,
        sessionId: section.sessionId,
        sectionId: section.sectionId,
      }).lean();
    }

    if (!enrollment?.history?.length) return true;
    const latest = enrollment.history[enrollment.history.length - 1];
    return isBlankUcbEnrollment(latest);
  } catch {
    return null;
  }
};

/**
 * Persist enrollment to a section, and fan out only to combinedSections siblings
 * whose own classes.berkeley.edu page is blank (0/0).
 */
const persistScrapedSectionEnrollmentWithFanOut = async (
  year: number,
  semester: Semester,
  section: ISectionItem,
  scraped: ParsedUcbEnrollment,
  now: Date
) => {
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

  let primaryDoc = null;
  for (const target of targets) {
    const doc = await persistScrapedSectionEnrollment(
      year,
      semester,
      target,
      scraped,
      now
    );
    if (target.sectionId === section.sectionId) {
      primaryDoc = doc;
    }
  }

  return primaryDoc;
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

const scrapeEnrollmentForSection = async (
  section: ISectionItem,
  redis: RedisClientType
) => {
  if (!section.component) return null;
  const url = buildUcbCatalogUrl({
    year: section.year,
    semester: section.semester as Semester,
    subject: section.subject,
    courseNumber: section.courseNumber,
    number: section.number,
    component: section.component,
  });
  try {
    const scraped = await fetchUcbCatalogEnrollment(url, redis);
    if (isBlankUcbEnrollment(scraped.primary)) return null;
    return scraped;
  } catch {
    return null;
  }
};

export const getEnrollment = async (
  year: number,
  semester: Semester,
  sessionId: string | null,
  subject: string,
  courseNumber: string,
  sectionNumber: string
) => {
  const subjectQuery = buildSubjectQuery(subject);

  const enrollment = await NewEnrollmentHistoryModel.findOne({
    year,
    semester,
    sessionId: sessionId ? sessionId : "1",
    subject: subjectQuery,
    courseNumber,
    sectionNumber,
  }).lean();

  if (!enrollment) return null;

  return formatEnrollment(enrollment);
};

export const getEnrollmentBySectionId = async (
  termId: string,
  sessionId: string,
  sectionId: string
) => {
  const enrollment = await NewEnrollmentHistoryModel.findOne({
    termId,
    sessionId,
    sectionId,
  }).lean();

  if (!enrollment) return null;

  return formatEnrollment(enrollment);
};

export const refreshClassEnrollment = async (
  year: number,
  semester: Semester,
  sessionId: string | null,
  subject: string,
  courseNumber: string,
  number: string,
  redis: RedisClientType
) => {
  const resolvedSessionId = sessionId || "1";

  const primarySection = await SectionModel.findOne({
    year,
    semester,
    sessionId: resolvedSessionId,
    subject: buildSubjectQuery(subject),
    courseNumber,
    number,
    primary: true,
  }).lean();

  if (!primarySection?.sectionId || !primarySection.component) {
    throw new GraphQLError("Class primary section not found", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }

  const combinedSiblings = await findCombinedSiblingSections(
    primarySection as ISectionItem
  );
  const scrapeCandidates = [primarySection as ISectionItem, ...combinedSiblings];

  let scrapedCatalog = null;
  for (const candidate of scrapeCandidates) {
    scrapedCatalog = await scrapeEnrollmentForSection(candidate, redis);
    if (scrapedCatalog) break;
  }

  if (!scrapedCatalog) {
    throw new GraphQLError(
      "No usable enrollment found on this listing or its cross-listed sections",
      { extensions: { code: "BAD_USER_INPUT" } }
    );
  }

  const now = new Date();

  const enrollmentDoc = await persistScrapedSectionEnrollmentWithFanOut(
    year,
    semester,
    primarySection as ISectionItem,
    scrapedCatalog.primary,
    now
  );

  if (!enrollmentDoc) {
    throw new GraphQLError("Failed to persist refreshed enrollment", {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }

  const associatedBySectionId = new Map(
    scrapedCatalog.associatedSections.map((section) => [
      section.sectionId,
      section,
    ])
  );
  const associatedByNumber = new Map(
    scrapedCatalog.associatedSections
      .filter((section) => section.sectionNumber)
      .map((section) => [section.sectionNumber!, section])
  );
  const scrapedSectionIds = scrapedCatalog.associatedSections.map(
    (section) => section.sectionId
  );
  const scrapedSectionIdNums = scrapedSectionIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  const associatedSections = await SectionModel.find({
    year,
    semester,
    sessionId: resolvedSessionId,
    subject: buildSubjectQuery(subject),
    courseNumber,
    primary: false,
    $or: [
      { sectionId: { $in: scrapedSectionIds } },
      { number: { $in: [...associatedByNumber.keys()] } },
      ...(scrapedSectionIdNums.length > 0
        ? [{ combinedSections: { $in: scrapedSectionIdNums } }]
        : []),
    ],
  }).lean();

  await Promise.all(
    associatedSections.map((section) => {
      const scraped = matchAssociatedScrapedEnrollment(
        section as ISectionItem,
        associatedBySectionId,
        associatedByNumber
      );
      if (!scraped) return Promise.resolve();
      return persistScrapedSectionEnrollmentWithFanOut(
        year,
        semester,
        section as ISectionItem,
        scraped,
        now
      );
    })
  );

  invalidateCatalogCache(year, semester);
  // Catalog/class enrollment responses live in Apollo's Redis response cache
  // (Enrollment maxAge=60, catalogSearch maxAge=300). Clear them so the next
  // client refetch sees the scrape instead of a stale cached payload.
  await invalidateApolloResponseCache(redis);

  const refreshed = await NewEnrollmentHistoryModel.findById(
    enrollmentDoc._id
  ).lean();

  if (!refreshed) {
    throw new GraphQLError("Failed to load refreshed enrollment", {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }

  return formatEnrollment(refreshed);
};
