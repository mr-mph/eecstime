import { connection } from "mongoose";

import {
  normalizeSubject,
  parseTermName,
  parseTimeToMinutes,
} from "@repo/common";
import { SUBJECT_NICKNAME_MAP } from "@repo/common/lib/departmentNicknames";
import {
  AggregatedMetricsModel,
  CatalogClassModel,
  ClassModel,
  ClassViewCountModel,
  CourseModel,
  ICatalogClassItem,
  ISectionItem,
  NewEnrollmentHistoryModel,
  RmpProfessorModel,
  SectionModel,
  TermModel,
} from "@repo/common/models";
import {
  RMP_MISSING_RATING_FOR_SORT,
  getBerkeleytimeAverageRating,
  getBerkeleytimeRatingCount,
  instructorLookupKey,
  isLsBreadthRequirement,
  isUniversityRequirementLabel,
  normalizeInstructorName,
  resolveInstructorMatch,
} from "@repo/shared";

import { Config } from "../shared/config";
import { getCurrentCatalogTerm } from "../shared/term-selectors";
import {
  buildActiveSeatReservations,
  buildPreservedSeatReservationCountsFromHistory,
  preserveRemovedActiveSeatReservations,
} from "./enrollment-utils";

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

export type UpdateCatalogEnrollmentOptions = {
  /** Also patch embedded secondary sections (discussion/lab). Default true. */
  includeSecondary?: boolean;
};

const BULK_BATCH_SIZE = 500;

const seatReservationsEqual = (
  a: CatalogEnrollmentPatch["seatReservations"],
  b: CatalogEnrollmentPatch["seatReservations"]
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    if (
      l.description !== r.description ||
      l.enrolledCount !== r.enrolledCount ||
      l.maxEnroll !== r.maxEnroll
    ) {
      return false;
    }
  }
  return true;
};

const catalogEnrollmentPatchMatches = (
  existing: Pick<
    ICatalogClassItem,
    | "enrollmentStatus"
    | "enrolledCount"
    | "maxEnroll"
    | "waitlistedCount"
    | "maxWaitlist"
    | "activeReservedMaxCount"
    | "seatReservations"
  >,
  patch: CatalogEnrollmentPatch
): boolean =>
  existing.enrollmentStatus === patch.status &&
  existing.enrolledCount === patch.enrolledCount &&
  existing.maxEnroll === patch.maxEnroll &&
  existing.waitlistedCount === patch.waitlistedCount &&
  existing.maxWaitlist === patch.maxWaitlist &&
  (existing.activeReservedMaxCount ?? 0) ===
    (patch.activeReservedMaxCount ?? 0) &&
  seatReservationsEqual(existing.seatReservations, patch.seatReservations);

type AggregatedMetric = {
  metricName: string;
  count: number;
  weightedAverage: number;
};

const aggregateRatingsForCourses = async (
  courseIds: string[]
): Promise<Map<string, AggregatedMetric[]>> => {
  const results = await AggregatedMetricsModel.aggregate([
    { $match: { courseId: { $in: courseIds }, categoryCount: { $gt: 0 } } },
    {
      $group: {
        _id: {
          courseId: "$courseId",
          metricName: "$metricName",
          categoryValue: "$categoryValue",
        },
        categoryCount: { $sum: "$categoryCount" },
      },
    },
    {
      $group: {
        _id: { courseId: "$_id.courseId", metricName: "$_id.metricName" },
        totalCount: { $sum: "$categoryCount" },
        sumValues: {
          $sum: { $multiply: ["$_id.categoryValue", "$categoryCount"] },
        },
      },
    },
    {
      $group: {
        _id: "$_id.courseId",
        metrics: {
          $push: {
            metricName: "$_id.metricName",
            count: "$totalCount",
            weightedAverage: {
              $cond: [
                { $eq: ["$totalCount", 0] },
                0,
                { $divide: ["$sumValues", "$totalCount"] },
              ],
            },
          },
        },
      },
    },
  ]);
  return new Map(results.map((r: any) => [r._id, r.metrics]));
};

const getLevel = (
  academicCareer: string | undefined,
  courseNumber: string
): string => {
  if (academicCareer === "UGRD") {
    return courseNumber.match(/(\d)\d\d/) ? "Upper Division" : "Lower Division";
  }
  if (academicCareer === "GRAD") return "Graduate";
  if (academicCareer === "UCBX") return "Extension";
  return "Lower Division";
};

const buildSearchableNames = (
  subject: string,
  courseNumber: string,
  departmentNicknames: string | undefined
): string[] => {
  const normalizedSubject = normalizeSubject(subject);
  const containsPrefix = /^[a-zA-Z].*/.test(courseNumber);
  const alternateNumber = courseNumber.slice(1);

  // Collect all abbreviations from SIS nicknames and hardcoded map
  const sisNicknames = departmentNicknames
    ? departmentNicknames
        .split("!")
        .map((abbr: string) => abbr.trim())
        .filter(Boolean)
    : [];

  const hardcodedNicknames = SUBJECT_NICKNAME_MAP[normalizedSubject] || [];
  const abbreviations = [...new Set([...sisNicknames, ...hardcodedNicknames])];

  const names = new Set<string>();

  // Add canonical name
  names.add(`${normalizedSubject} ${courseNumber}`);
  names.add(`${normalizedSubject}${courseNumber}`);

  if (containsPrefix) {
    names.add(`${normalizedSubject} ${alternateNumber}`);
    names.add(`${normalizedSubject}${alternateNumber}`);
  }

  // Add nickname variations
  for (const abbreviation of abbreviations) {
    const abbr = abbreviation.toUpperCase();
    names.add(`${abbr} ${courseNumber}`);
    names.add(`${abbr}${courseNumber}`);

    if (containsPrefix) {
      names.add(`${abbr} ${alternateNumber}`);
      names.add(`${abbr}${alternateNumber}`);
    }
  }

  return Array.from(names);
};

const filterInstructors = (
  instructors:
    | {
        printInScheduleOfClasses?: boolean;
        familyName?: string;
        givenName?: string;
        role?: string;
      }[]
    | undefined
) => {
  if (!instructors) return [];

  const pis = instructors.filter(
    (i) =>
      i.role === "PI" &&
      typeof i.familyName === "string" &&
      typeof i.givenName === "string"
  );

  const list =
    pis.length > 0
      ? pis
      : instructors.filter(
          (i) =>
            typeof i.familyName === "string" && typeof i.givenName === "string"
        );

  return list
    .map((i) => ({
      familyName: i.familyName!,
      givenName: i.givenName!,
    }))
    .sort((a, b) => a.familyName.localeCompare(b.familyName));
};

/**
 * Builds denormalized catalog class documents for a given term.
 * Joins classes + courses + sections + enrollment into single documents.
 */
export const buildCatalogClasses = async (
  year: number,
  semester: string
): Promise<ICatalogClassItem[]> => {
  const [term, classes] = await Promise.all([
    TermModel.findOne({ name: `${year} ${semester}` })
      .select({ _id: 1, id: 1 })
      .lean(),
    ClassModel.find({
      year,
      semester,
      // Real DeCals always have a title; ignore stub `{ instructors: [] }` docs.
      $or: [
        { anyPrintInScheduleOfClasses: true },
        { "decal.title": { $exists: true, $nin: [null, ""] } },
      ],
    }).lean(),
  ]);

  if (!term || classes.length === 0) return [];

  const courseIds = [...new Set(classes.map((c) => c.courseId))];

  const [courses, sections] = await Promise.all([
    CourseModel.find({
      courseId: { $in: courseIds },
      printInCatalog: true,
    }).lean(),
    SectionModel.find({
      year,
      semester,
      courseId: { $in: courseIds },
      printInScheduleOfClasses: true,
    }).lean(),
  ]);

  // Fetch enrollment, view counts, and ratings in parallel
  const sectionIds = sections.map((s) => s.sectionId);
  const [enrollments, viewCounts, ratingsMap] = await Promise.all([
    NewEnrollmentHistoryModel.find({
      termId: term.id,
      sectionId: { $in: sectionIds },
    }).lean(),
    ClassViewCountModel.find({ year, semester }).lean(),
    aggregateRatingsForCourses(courseIds),
  ]);

  // Build lookup maps
  const courseMap = new Map(courses.map((c) => [c.courseId, c]));

  const sectionMap = new Map<string, ISectionItem[]>();
  for (const section of sections) {
    const key = `${section.courseId}-${section.classNumber}`;
    const existing = sectionMap.get(key);
    if (existing) {
      existing.push(section);
    } else {
      sectionMap.set(key, [section]);
    }
  }

  const enrollmentMap = new Map<string, (typeof enrollments)[number]>();
  for (const enrollment of enrollments) {
    enrollmentMap.set(enrollment.sectionId, enrollment);
  }

  const viewCountMap = new Map<string, number>();
  for (const vc of viewCounts) {
    const normalizedViewCountSubject = normalizeSubject(vc.subject);
    const key = `${vc.sessionId}:${normalizedViewCountSubject}:${vc.courseNumber}:${vc.number}`;
    viewCountMap.set(key, vc.viewCount ?? 0);
  }

  // Build denormalized documents
  const catalogClasses: ICatalogClassItem[] = [];

  for (const _class of classes) {
    const course = courseMap.get(_class.courseId);
    if (!course) continue;

    const classSections =
      sectionMap.get(`${_class.courseId}-${_class.number}`) ?? [];
    const primaryIdx = classSections.findIndex((s) => s.primary);
    if (primaryIdx === -1) continue;

    const primarySection = classSections[primaryIdx];
    const secondarySections = classSections.filter((_, i) => i !== primaryIdx);

    // Extract enrollment for primary section
    const primaryEnrollment = enrollmentMap.get(primarySection.sectionId);
    const latestEnrollment =
      primaryEnrollment?.history?.[primaryEnrollment.history.length - 1];
    const seatReservations = buildActiveSeatReservations(
      latestEnrollment?.seatReservationCount,
      primaryEnrollment?.seatReservationTypes
    );
    const activeReservedMaxCount = seatReservations.reduce(
      (sum, reservation) => sum + reservation.maxEnroll,
      0
    );

    // Compute pre-computed fields
    const normalizedSubject = normalizeSubject(_class.subject);
    const level = getLevel(course.academicCareer, _class.courseNumber);

    // Compute meeting time fields from primary section
    const primaryMeetings = primarySection.meetings ?? [];
    const meetingDays = [false, false, false, false, false, false, false];
    let meetingStartMinutes: number | null = null;
    let meetingEndMinutes: number | null = null;

    for (const meeting of primaryMeetings) {
      if (meeting.days) {
        meeting.days.forEach((day, idx) => {
          if (day && idx < 7) meetingDays[idx] = true;
        });
      }
      if (meeting.startTime) {
        const mins = parseTimeToMinutes(meeting.startTime);
        if (
          mins !== null &&
          (meetingStartMinutes === null || mins < meetingStartMinutes)
        ) {
          meetingStartMinutes = mins;
        }
      }
      if (meeting.endTime) {
        const mins = parseTimeToMinutes(meeting.endTime);
        if (
          mins !== null &&
          (meetingEndMinutes === null || mins > meetingEndMinutes)
        ) {
          meetingEndMinutes = mins;
        }
      }
    }

    // Extract L&S breadths from GE section attributes (exclude university reqs
    // like American Cultures that SIS sometimes tags as GE).
    const breadthRequirements: string[] = [];
    const sectionAttributes = primarySection.sectionAttributes ?? [];
    for (const attr of sectionAttributes) {
      if (
        attr.attribute?.code === "GE" &&
        attr.value?.description &&
        isLsBreadthRequirement(attr.value.description)
      ) {
        breadthRequirements.push(attr.value.description);
      }
    }

    // Extract university requirements from requirement designation + GE labels
    const universityRequirements: string[] = [];
    if (_class.requirementDesignation?.description) {
      universityRequirements.push(_class.requirementDesignation.description);
    }
    for (const attr of sectionAttributes) {
      if (
        attr.attribute?.code === "GE" &&
        attr.value?.description &&
        isUniversityRequirementLabel(attr.value.description) &&
        !universityRequirements.includes(attr.value.description)
      ) {
        universityRequirements.push(attr.value.description);
      }
    }

    // Build searchable names
    const searchableNames = buildSearchableNames(
      _class.subject,
      _class.courseNumber,
      course.departmentNicknames
    );

    // View count
    const viewCountKey = `${_class.sessionId}:${normalizedSubject}:${_class.courseNumber}:${_class.number}`;

    // Build secondary sections with enrollment
    const formattedSections = secondarySections.map((section) => {
      const enrollment = enrollmentMap.get(section.sectionId);
      const latest = enrollment?.history?.[enrollment.history.length - 1];
      return {
        sectionId: section.sectionId,
        number: section.number,
        component: section.component,
        online: section.instructionMode === "O",
        meetings: section.meetings?.map((m) => ({
          ...m,
          instructors: filterInstructors(m.instructors),
        })),
        enrollmentStatus: latest?.status,
        enrolledCount: latest?.enrolledCount,
        maxEnroll: latest?.maxEnroll,
        waitlistedCount: latest?.waitlistedCount,
        maxWaitlist: latest?.maxWaitlist,
      };
    });

    catalogClasses.push({
      // Identity
      year: _class.year,
      semester: _class.semester,
      termId: _class.termId,
      sessionId: _class.sessionId,
      subject: normalizedSubject,
      courseNumber: _class.courseNumber,
      number: _class.number,
      courseId: _class.courseId,

      // Class fields
      title: _class.title,
      description: _class.description,
      gradingBasis: _class.gradingBasis,
      finalExam: _class.finalExam,
      unitsMin: _class.allowedUnits?.minimum ?? 0,
      unitsMax: _class.allowedUnits?.maximum ?? 0,
      instructionMode: _class.instructionMode,
      anyPrintInScheduleOfClasses: _class.anyPrintInScheduleOfClasses,
      requirementDesignation: _class.requirementDesignation,

      // Course fields (flattened)
      courseTitle: course.title,
      courseDescription: course.description,
      departmentNicknames: course.departmentNicknames,
      academicCareer: course.academicCareer,
      academicOrganization: course.academicOrganization,
      academicOrganizationName: course.academicOrganizationName,
      allTimeAverageGrade: course.allTimeAverageGrade ?? null,
      allTimePassCount: course.allTimePassCount ?? null,
      allTimeNoPassCount: course.allTimeNoPassCount ?? null,
      allTimeAPlusAPercentage: course.allTimeAPlusAPercentage ?? null,

      // Primary section fields
      primarySectionId: primarySection.sectionId,
      primaryComponent: primarySection.component,
      primaryOnline: primarySection.instructionMode === "O",
      sectionAttributes: primarySection.sectionAttributes,
      meetings: primaryMeetings.map((m) => ({
        ...m,
        instructors: filterInstructors(m.instructors),
      })),
      exams: primarySection.exams,

      // Pre-computed filter fields
      level,
      meetingDays,
      meetingStartMinutes,
      meetingEndMinutes,
      breadthRequirements,
      universityRequirements,

      // Search fields
      searchableNames,

      // Enrollment (latest snapshot)
      enrollmentStatus: latestEnrollment?.status,
      enrolledCount: latestEnrollment?.enrolledCount,
      maxEnroll: latestEnrollment?.maxEnroll,
      waitlistedCount: latestEnrollment?.waitlistedCount,
      maxWaitlist: latestEnrollment?.maxWaitlist,
      activeReservedMaxCount,
      seatReservations,
      enrollmentUpdatedAt: latestEnrollment?.endTime
        ? new Date(latestEnrollment.endTime)
        : null,

      // Pre-computed sort fields
      openSeats: Math.max(
        0,
        (latestEnrollment?.maxEnroll ?? 0) -
          (latestEnrollment?.enrolledCount ?? 0)
      ),
      berkeleytimeAverageRating: ratingsMap.has(_class.courseId)
        ? getBerkeleytimeAverageRating(ratingsMap.get(_class.courseId)!)
        : null,
      berkeleytimeRatingCount: ratingsMap.has(_class.courseId)
        ? getBerkeleytimeRatingCount(ratingsMap.get(_class.courseId)!)
        : 0,
      rmpAverageRating: null,
      rmpMatchedInstructorCount: 0,

      // Secondary sections
      sections: formattedSections,

      // DeCal data
      decal: _class.decal ? { title: _class.decal.title } : undefined,

      // Ratings/grades
      viewCount: viewCountMap.get(viewCountKey) ?? 0,
      aggregatedRatings: ratingsMap.has(_class.courseId)
        ? { metrics: ratingsMap.get(_class.courseId)! }
        : null,
    });
  }

  return catalogClasses;
};

/**
 * Refreshes the catalog_classes collection for a given term.
 * Uses a transaction to atomically replace all docs for the term.
 */
export const refreshCatalogClasses = async (
  log: Config["log"],
  year: number,
  semester: string
) => {
  log.info(`Building denormalized catalog for ${year} ${semester}...`);

  const catalogClasses = await buildCatalogClasses(year, semester);

  if (catalogClasses.length === 0) {
    log.warn(`No catalog classes built for ${year} ${semester}, skipping.`);
    return;
  }

  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      const { deletedCount } = await CatalogClassModel.deleteMany(
        { year, semester },
        { session }
      );

      log.trace(
        `Deleted ${deletedCount} existing catalog classes for ${year} ${semester}`
      );

      // Insert in batches to avoid transaction size limits
      const BATCH_SIZE = 2000;
      let insertedCount = 0;
      for (let i = 0; i < catalogClasses.length; i += BATCH_SIZE) {
        const batch = catalogClasses.slice(i, i + BATCH_SIZE);
        const result = await CatalogClassModel.insertMany(batch, {
          ordered: false,
          session,
        });
        insertedCount += result.length;
      }

      log.info(
        `Inserted ${insertedCount} catalog classes for ${year} ${semester}`
      );
    });
  } finally {
    await session.endSession();
  }

  // Re-apply RMP averages if the professor cache has been populated.
  await updateCatalogRmpRatings(log, year, semester);
};

/**
 * Refreshes the catalog_classes collection for all terms with catalog data.
 * Used for manual rebuilds and migrations.
 */
export const refreshAllCatalogClasses = async (log: Config["log"]) => {
  const termNames = await TermModel.distinct("name", {
    hasCatalogData: true,
  });

  log.info(
    `Rebuilding catalog for ${termNames.length} terms with catalog data...`
  );

  const parsedTerms = termNames
    .map(parseTermName)
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const CONCURRENCY = 3;
  for (let i = 0; i < parsedTerms.length; i += CONCURRENCY) {
    const batch = parsedTerms.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((t) => refreshCatalogClasses(log, t.year, t.semester))
    );
  }

  log.info("Catalog rebuild complete.");
};

/**
 * Updates only the aggregated ratings on catalog_classes for a given term.
 * Runs the same bulk aggregation pipeline as buildCatalogClasses but scoped
 * to courseIds present in the catalog for this term.
 */
export const updateCatalogRatings = async (
  log: Config["log"],
  year: number,
  semester: string
) => {
  const courseIds = await CatalogClassModel.distinct("courseId", {
    year,
    semester,
  });

  if (courseIds.length === 0) return;

  const [ratingsMap, viewCounts] = await Promise.all([
    aggregateRatingsForCourses(courseIds),
    ClassViewCountModel.find({ year, semester }).lean(),
  ]);

  const bulkOps: Parameters<typeof CatalogClassModel.bulkWrite>[0] = [];

  // Sync view counts
  for (const vc of viewCounts) {
    const count = vc.viewCount ?? 0;
    if (count === 0) continue;
    const normalizedViewCountSubject = normalizeSubject(vc.subject);
    bulkOps.push({
      updateOne: {
        filter: {
          year,
          semester,
          sessionId: vc.sessionId,
          subject: normalizedViewCountSubject,
          courseNumber: vc.courseNumber,
          number: vc.number,
        },
        update: { $set: { viewCount: count } },
      },
    });
  }

  for (const [courseId, metrics] of ratingsMap) {
    bulkOps.push({
      updateMany: {
        filter: { year, semester, courseId },
        update: {
          $set: {
            aggregatedRatings: { metrics },
            berkeleytimeAverageRating: getBerkeleytimeAverageRating(metrics),
            berkeleytimeRatingCount: getBerkeleytimeRatingCount(metrics),
          },
        },
      },
    });
  }

  // Null out ratings for courses that no longer have any
  const courseIdsWithoutRatings = courseIds.filter((id) => !ratingsMap.has(id));

  if (courseIdsWithoutRatings.length > 0) {
    bulkOps.push({
      updateMany: {
        filter: { year, semester, courseId: { $in: courseIdsWithoutRatings } },
        update: {
          $set: {
            aggregatedRatings: null,
            berkeleytimeAverageRating: null,
            berkeleytimeRatingCount: 0,
          },
        },
      },
    });
  }

  if (bulkOps.length > 0) {
    const result = await CatalogClassModel.bulkWrite(bulkOps, {
      ordered: false,
    });
    log.info(
      `Updated ratings + view counts for ${ratingsMap.size} courses, ${viewCounts.length} view entries on catalog_classes (${result.modifiedCount} docs modified)`
    );
  }
};

/**
 * Sync Berkeleytime rating sort fields (avg / count) + aggregatedRatings onto
 * catalog_classes for every term that has catalog rows. Needed after public
 * backup merges, which often restore catalog without these denormalized fields.
 */
export const updateCatalogRatingsForAllCatalogTerms = async (
  log: Config["log"]
) => {
  const terms = await CatalogClassModel.aggregate<{
    year: number;
    semester: string;
  }>([
    {
      $group: {
        _id: { year: "$year", semester: "$semester" },
      },
    },
    {
      $project: {
        _id: 0,
        year: "$_id.year",
        semester: "$_id.semester",
      },
    },
    { $sort: { year: -1, semester: 1 } },
  ]);

  if (terms.length === 0) {
    log.warn("No catalog terms found; skipping catalog ratings sync");
    return;
  }

  log.info(
    `Syncing Berkeleytime rating sort fields for ${terms.length} catalog term(s)`
  );
  for (const term of terms) {
    await updateCatalogRatings(log, term.year, term.semester);
  }
};

/**
 * Updates denormalized all-time grade summary fields on catalog_classes.
 * Uses courseId joins so we can refresh grades without rebuilding the catalog.
 */
export const updateCatalogGradeSummaries = async (log: Config["log"]) => {
  const courseIds = (await CatalogClassModel.distinct("courseId")) as string[];
  if (courseIds.length === 0) return;

  const courses = await CourseModel.find({
    courseId: { $in: courseIds },
  })
    .select({
      courseId: 1,
      allTimeAverageGrade: 1,
      allTimePassCount: 1,
      allTimeNoPassCount: 1,
      allTimeAPlusAPercentage: 1,
    })
    .lean();

  const seenCourseIds = new Set<string>();
  const bulkOps: Parameters<typeof CatalogClassModel.bulkWrite>[0] = [];

  for (const course of courses) {
    if (!course.courseId) continue;
    seenCourseIds.add(course.courseId);

    bulkOps.push({
      updateMany: {
        filter: { courseId: course.courseId },
        update: {
          $set: {
            allTimeAverageGrade: course.allTimeAverageGrade ?? null,
            allTimePassCount: course.allTimePassCount ?? null,
            allTimeNoPassCount: course.allTimeNoPassCount ?? null,
            allTimeAPlusAPercentage: course.allTimeAPlusAPercentage ?? null,
          },
        },
      },
    });
  }

  const courseIdsWithoutCourseRows = courseIds.filter(
    (courseId) => !seenCourseIds.has(courseId)
  );

  if (courseIdsWithoutCourseRows.length > 0) {
    bulkOps.push({
      updateMany: {
        filter: { courseId: { $in: courseIdsWithoutCourseRows } },
        update: {
          $set: {
            allTimeAverageGrade: null,
            allTimePassCount: null,
            allTimeNoPassCount: null,
            allTimeAPlusAPercentage: null,
          },
        },
      },
    });
  }

  if (bulkOps.length === 0) return;

  const BULK_BATCH_SIZE = 500;
  let modifiedCount = 0;
  for (let i = 0; i < bulkOps.length; i += BULK_BATCH_SIZE) {
    const batch = bulkOps.slice(i, i + BULK_BATCH_SIZE);
    const result = await CatalogClassModel.bulkWrite(batch, {
      ordered: false,
    });
    modifiedCount += result.modifiedCount;
  }

  log.info(
    `Updated grade summaries for ${seenCourseIds.size.toLocaleString()} courses on catalog_classes (${modifiedCount.toLocaleString()} docs modified)`
  );
};

/**
 * Push latest enrollmenthistories snapshots (including reserved seats) onto
 * catalog_classes for one term. Used after backup merges and enrollment pulls.
 */
export const syncCatalogEnrollmentFromHistories = async (
  log: Config["log"],
  year: number,
  semester: string
) => {
  const primarySectionIds = (
    await CatalogClassModel.distinct("primarySectionId", { year, semester })
  ).filter((id): id is string => Boolean(id));

  if (primarySectionIds.length === 0) {
    log.info(
      `No catalog classes for ${semester} ${year}; skipping enrollment sync`
    );
    return;
  }

  const existingCatalog = await CatalogClassModel.find({ year, semester })
    .select({
      primarySectionId: 1,
      enrollmentStatus: 1,
      enrolledCount: 1,
      maxEnroll: 1,
      waitlistedCount: 1,
      maxWaitlist: 1,
      activeReservedMaxCount: 1,
      seatReservations: 1,
    })
    .lean();
  const existingByPrimarySectionId = new Map(
    existingCatalog.map((doc) => [doc.primarySectionId, doc])
  );

  const histories = await NewEnrollmentHistoryModel.find({
    year,
    semester,
    sectionId: { $in: primarySectionIds },
  })
    .select({
      sectionId: 1,
      seatReservationTypes: 1,
      "history.seatReservationCount": 1,
      "history.status": 1,
      "history.enrolledCount": 1,
      "history.maxEnroll": 1,
      "history.waitlistedCount": 1,
      "history.maxWaitlist": 1,
    })
    .lean();

  const termEnrollments = new Map<string, CatalogEnrollmentPatch>();
  let skippedUnchanged = 0;

  for (const hist of histories) {
    const history = hist.history ?? [];
    const latest = history[history.length - 1];
    if (!latest) continue;

    const preservedCounts =
      buildPreservedSeatReservationCountsFromHistory(history);
    const existing = existingByPrimarySectionId.get(hist.sectionId);
    const seatReservations = preserveRemovedActiveSeatReservations(
      buildActiveSeatReservations(preservedCounts, hist.seatReservationTypes),
      existing?.seatReservations
    );

    const patch: CatalogEnrollmentPatch = {
      status: latest.status,
      enrolledCount: latest.enrolledCount,
      maxEnroll: latest.maxEnroll,
      waitlistedCount: latest.waitlistedCount,
      maxWaitlist: latest.maxWaitlist,
      activeReservedMaxCount: seatReservations.reduce(
        (sum, reservation) => sum + reservation.maxEnroll,
        0
      ),
      seatReservations,
    };

    if (existing && catalogEnrollmentPatchMatches(existing, patch)) {
      skippedUnchanged += 1;
      continue;
    }

    termEnrollments.set(hist.sectionId, patch);
  }

  if (termEnrollments.size === 0) {
    log.info(
      `Catalog enrollment already up to date for ${semester} ${year} (${skippedUnchanged} primary section(s) unchanged)`
    );
    return;
  }

  log.info(
    `Syncing ${termEnrollments.size} changed primary section(s) for ${semester} ${year} (${skippedUnchanged} unchanged)`
  );
  await updateCatalogEnrollment(log, year, semester, termEnrollments, {
    includeSecondary: false,
  });
};

/** Sync enrollment onto catalog_classes for the current active term only. */
export const syncCatalogEnrollmentForCurrentTerm = async (
  log: Config["log"]
) => {
  const currentTerm = await getCurrentCatalogTerm();
  if (!currentTerm) {
    log.warn(
      "No active term with catalog data; skipping catalog enrollment sync"
    );
    return;
  }

  log.info(
    `Syncing catalog enrollment from histories for ${currentTerm.semester} ${currentTerm.year}`
  );
  await syncCatalogEnrollmentFromHistories(
    log,
    currentTerm.year,
    currentTerm.semester
  );
};

/**
 * Sync enrollment (including reserved seats) onto catalog_classes for every
 * term that has catalog rows. Needed after public-backup merges, which restore
 * catalog without denormalized seatReservations for past terms.
 */
export const syncCatalogEnrollmentForAllCatalogTerms = async (
  log: Config["log"]
) => {
  const terms = await CatalogClassModel.aggregate<{
    year: number;
    semester: string;
  }>([
    {
      $group: {
        _id: { year: "$year", semester: "$semester" },
      },
    },
    {
      $project: {
        _id: 0,
        year: "$_id.year",
        semester: "$_id.semester",
      },
    },
    { $sort: { year: -1, semester: 1 } },
  ]);

  if (terms.length === 0) {
    log.warn("No catalog terms found; skipping catalog enrollment sync");
    return;
  }

  log.info(
    `Syncing catalog enrollment from histories for ${terms.length} term(s)`
  );
  for (const term of terms) {
    await syncCatalogEnrollmentFromHistories(log, term.year, term.semester);
  }
};

/**
 * Updates only the enrollment fields on catalog_classes for sections that changed.
 * Much cheaper than a full rebuild - used by the enrollment puller.
 */
export const updateCatalogEnrollment = async (
  log: Config["log"],
  year: number,
  semester: string,
  sectionEnrollments: Map<string, CatalogEnrollmentPatch>,
  options: UpdateCatalogEnrollmentOptions = {}
) => {
  const { includeSecondary = true } = options;
  if (sectionEnrollments.size === 0) return;

  const bulkOps: any[] = [];

  for (const [sectionId, enrollment] of sectionEnrollments) {
    // Update primary section enrollment
    const openSeats = Math.max(
      0,
      (enrollment.maxEnroll ?? 0) - (enrollment.enrolledCount ?? 0)
    );
    bulkOps.push({
      updateMany: {
        filter: { year, semester, primarySectionId: sectionId },
        update: {
          $set: {
            enrollmentStatus: enrollment.status,
            enrolledCount: enrollment.enrolledCount,
            maxEnroll: enrollment.maxEnroll,
            waitlistedCount: enrollment.waitlistedCount,
            maxWaitlist: enrollment.maxWaitlist,
            activeReservedMaxCount: enrollment.activeReservedMaxCount,
            ...(enrollment.seatReservations !== undefined
              ? { seatReservations: enrollment.seatReservations }
              : {}),
            openSeats,
            ...(enrollment.enrollmentUpdatedAt
              ? { enrollmentUpdatedAt: enrollment.enrollmentUpdatedAt }
              : {}),
          },
        },
      },
    });

    if (includeSecondary) {
      // Update secondary sections enrollment
      bulkOps.push({
        updateMany: {
          filter: { year, semester, "sections.sectionId": sectionId },
          update: {
            $set: {
              "sections.$.enrollmentStatus": enrollment.status,
              "sections.$.enrolledCount": enrollment.enrolledCount,
              "sections.$.maxEnroll": enrollment.maxEnroll,
              "sections.$.waitlistedCount": enrollment.waitlistedCount,
              "sections.$.maxWaitlist": enrollment.maxWaitlist,
            },
          },
        },
      });
    }
  }

  if (bulkOps.length === 0) return;

  let modifiedCount = 0;
  for (let i = 0; i < bulkOps.length; i += BULK_BATCH_SIZE) {
    const batch = bulkOps.slice(i, i + BULK_BATCH_SIZE);
    const result = await CatalogClassModel.bulkWrite(batch, {
      ordered: false,
    });
    modifiedCount += result.modifiedCount;
  }

  log.info(
    `Updated enrollment for ${sectionEnrollments.size} section(s) on catalog_classes (${modifiedCount} docs modified)`
  );
};

/**
 * Match primary instructors on catalog classes to cached RMP professors and
 * set rmpAverageRating for sorting (missing/N/A instructors count as 3).
 * Also stores how many instructors had a real RMP rating for display.
 */
export const updateCatalogRmpRatings = async (
  log: Config["log"],
  year?: number,
  semester?: string
) => {
  const professors = await RmpProfessorModel.find({
    numRatings: { $gt: 0 },
    avgRating: { $ne: null },
  })
    .select({ firstName: 1, lastName: 1, avgRating: 1, numRatings: 1 })
    .lean();

  if (professors.length === 0) {
    log.info("No RMP professors cached; skipping catalog RMP average update.");
    return;
  }

  const ratingByName = new Map<string, number>();
  for (const professor of professors) {
    if (professor.avgRating == null) continue;
    const key = instructorLookupKey(professor.firstName, professor.lastName);
    if (!ratingByName.has(key)) {
      ratingByName.set(key, professor.avgRating);
    }
  }

  // Also index by last name only for single-match fallbacks.
  const ratingsByLastName = new Map<string, number[]>();
  for (const professor of professors) {
    if (professor.avgRating == null) continue;
    const last = normalizeInstructorName(professor.lastName);
    if (!last) continue;
    const list = ratingsByLastName.get(last) ?? [];
    list.push(professor.avgRating);
    ratingsByLastName.set(last, list);
  }

  const catalogFilter: Record<string, unknown> = {};
  if (year != null && semester != null) {
    catalogFilter.year = year;
    catalogFilter.semester = semester;
  }

  const catalogClasses = await CatalogClassModel.find(catalogFilter)
    .select({ _id: 1, meetings: 1 })
    .lean();

  const ratingCache = new Map<string, number | null>();
  const ratingForInstructor = (
    given: string,
    family: string
  ): number | null => {
    const cacheKey = instructorLookupKey(given, family);
    const cached = ratingCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const rating = resolveInstructorMatch(
      given,
      family,
      ratingByName,
      ratingsByLastName
    );
    ratingCache.set(cacheKey, rating);
    return rating;
  };

  const bulkOps: Parameters<typeof CatalogClassModel.bulkWrite>[0] = [];

  for (const catalogClass of catalogClasses) {
    const sortRatings: number[] = [];
    let matchedCount = 0;
    const instructors =
      catalogClass.meetings?.flatMap((meeting) => meeting.instructors ?? []) ??
      [];

    for (const instructor of instructors) {
      const given = instructor.givenName?.trim() ?? "";
      const family = instructor.familyName?.trim() ?? "";
      if (!family) continue;

      const rating = ratingForInstructor(given, family);

      if (rating != null) {
        matchedCount += 1;
        sortRatings.push(rating);
      } else {
        // N/A on RMP: neutral midpoint for ranking, not treated as a real score.
        sortRatings.push(RMP_MISSING_RATING_FOR_SORT);
      }
    }

    const rmpAverageRating =
      sortRatings.length > 0
        ? sortRatings.reduce((sum, value) => sum + value, 0) /
          sortRatings.length
        : null;

    bulkOps.push({
      updateOne: {
        filter: { _id: catalogClass._id },
        update: {
          $set: {
            rmpAverageRating,
            rmpMatchedInstructorCount: matchedCount,
          },
        },
      },
    });
  }

  if (bulkOps.length === 0) return;

  const BULK_BATCH_SIZE = 500;
  let modifiedCount = 0;
  for (let i = 0; i < bulkOps.length; i += BULK_BATCH_SIZE) {
    const batch = bulkOps.slice(i, i + BULK_BATCH_SIZE);
    const result = await CatalogClassModel.bulkWrite(batch, { ordered: false });
    modifiedCount += result.modifiedCount;
  }

  const scope =
    year != null && semester != null ? `${year} ${semester}` : "all terms";
  log.info(
    `Updated RMP averages for ${catalogClasses.length.toLocaleString()} catalog classes (${scope}, ${modifiedCount.toLocaleString()} docs modified, ${ratingByName.size.toLocaleString()} RMP professors indexed)`
  );
};
