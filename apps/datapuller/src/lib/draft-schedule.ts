/**
 * Tentative ("draft") EECS schedules for terms SIS hasn't published yet.
 *
 * EECS publishes a yearly draft schedule (e.g. "CS 2027-2028 Draft Schedule")
 * with one instructor column per term, usually well before the full schedule
 * of classes exists. We scrape it, and for every term column that has no real
 * schedule yet, seed Course / Class / Section docs tagged `isDraft: true`, flag
 * the term `isDraft` + `hasCatalogData`, and rebuild that term's catalog.
 *
 * Once the real schedule lands (the public backup / SIS starts carrying classes
 * for the term), the draft rows are deleted and the term's draft flag cleared,
 * so the full schedule replaces the tentative one automatically.
 *
 *  - Existing courses are REUSED by (subject, number) so draft classes inherit
 *    the real courseId, title, description, department and grade history. Only
 *    genuinely-new courses get a synthetic `draft-<subject>-<number>` courseId.
 *  - Everything written is tagged `isDraft: true`, so reseeding/retiring only
 *    ever touches its own rows — real data is never deleted.
 *  - The last scrape is stored in `draft_schedule_snapshots` (not part of the
 *    public backup) so hourly backup merges can reseed without refetching.
 */
import * as cheerio from "cheerio";
import { model, Schema } from "mongoose";

import {
  CatalogClassModel,
  ClassModel,
  CourseModel,
  SectionModel,
  TermModel,
} from "@repo/common/models";

import { Config } from "../shared/config";
import {
  buildCatalogClasses,
  syncCatalogEnrollmentForAllCatalogTerms,
  updateCatalogGradeSummaries,
  updateCatalogRatingsForAllCatalogTerms,
  updateCatalogRmpRatings,
} from "./catalog-denormalize";

const EECS_DRAFT_PAGES = [
  "https://www2.eecs.berkeley.edu/Scheduling/CS/schedule-draft.html",
  "https://www2.eecs.berkeley.edu/Scheduling/EE/schedule-draft.html",
];

/** Abbreviation used on eecs.berkeley.edu -> SIS subject code. */
const PAGE_SUBJECTS: Record<string, string> = {
  CS: "COMPSCI",
  EE: "ELENG",
  EECS: "EECS",
};

/**
 * A term counts as "fully released" once it has this many non-draft classes.
 * Real terms have thousands; this just guards against a stray early class.
 */
const MIN_REAL_CLASSES = 100;

const SEMESTER_TERM_DIGIT: Record<string, string> = {
  Spring: "2",
  Summer: "5",
  Fall: "8",
};

const DAY_COUNT = 7;

/** Catalog numbers whose real title lives on the class, not the course. */
const SPECIAL_TOPICS = /^[A-Z]?(98|194|198|290|294|298)$/;

export interface DraftCourse {
  subject: string;
  courseNumber: string;
  /** Explicit class number for special topics (e.g. CS 294-150 -> "150"). */
  number?: string;
  title?: string;
  /** Title column from the EECS page; only used for courses not in SIS. */
  pageTitle?: string;
  /** "Family, Given" (comma-less = family name only). */
  instructors: string[];
}

export interface DraftTerm {
  year: number;
  semester: string;
  sources: string[];
  courses: DraftCourse[];
}

interface IDraftScheduleSnapshot {
  name: string;
  year: number;
  semester: string;
  sources: string[];
  courses: DraftCourse[];
  fetchedAt: Date;
}

const draftScheduleSnapshotSchema = new Schema<IDraftScheduleSnapshot>({
  name: { type: String, required: true, unique: true },
  year: { type: Number, required: true },
  semester: { type: String, required: true },
  sources: { type: [String], default: [] },
  courses: { type: Schema.Types.Mixed, default: [] },
  fetchedAt: { type: Date, required: true },
});

const DraftScheduleSnapshotModel = model<IDraftScheduleSnapshot>(
  "draft_schedule_snapshot",
  draftScheduleSnapshotSchema
);

const termName = (year: number, semester: string) => `${year} ${semester}`;

const termIdFor = (year: number, semester: string) =>
  `2${String(year % 100).padStart(2, "0")}${SEMESTER_TERM_DIGIT[semester]}`;

/** "Dan Garcia" -> "Garcia, Dan"; already-comma'd names pass through. */
const toFamilyGiven = (raw: string): string | null => {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || /^(unknown|tba|staff)$/i.test(s)) return null;
  if (s.includes(",")) return s;
  const parts = s.split(" ");
  if (parts.length === 1) return s;
  const family = parts.pop()!;
  return `${family}, ${parts.join(" ")}`;
};

/** "CS 294-150" -> { subject: COMPSCI, courseNumber: "294", number: "150" }. */
const parseCourseLabel = (label: string) => {
  const m = label
    .replace(/\s+/g, " ")
    .trim()
    .match(/^([A-Z]+)\s+([A-Z]*\d+[A-Z]*)(?:-(\d+))?$/);
  if (!m) return null;
  const subject = PAGE_SUBJECTS[m[1]];
  if (!subject) return null;
  return {
    subject,
    courseNumber: m[2],
    number: m[3] ? m[3].padStart(3, "0") : undefined,
  };
};

const parseDraftPage = (html: string, source: string) => {
  const $ = cheerio.load(html);
  const table = $("#classes_by_courseno table").first();
  const terms = table
    .find("tr")
    .first()
    .find("th")
    .toArray()
    .map((th) => {
      const m = $(th)
        .text()
        .trim()
        .match(/^(Spring|Summer|Fall)\s+(\d{4})$/);
      return m ? { semester: m[1], year: Number(m[2]) } : null;
    })
    // Header cells are [Course, Title, <term>...]; keep column alignment.
    .slice(2);

  const byTerm = new Map<string, DraftTerm>();
  table
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const course = parseCourseLabel($(tr).find("th").first().text());
      if (!course) return;
      const cells = $(tr).find("td").toArray();
      const title = $(cells[0]).text().replace(/\s+/g, " ").trim();
      cells.slice(1).forEach((td, i) => {
        const term = terms[i];
        if (!term) return;
        const names = ($(td).html() ?? "")
          .split(/<br\s*\/?>/i)
          .map((chunk) => cheerio.load(chunk).text())
          .map(toFamilyGiven)
          .filter((n): n is string => n !== null);
        // An empty cell means "not offered this term".
        if (!names.length && !$(td).text().trim()) return;
        const key = termName(term.year, term.semester);
        const draft = byTerm.get(key) ?? {
          ...term,
          sources: [source],
          courses: [],
        };
        draft.courses.push({
          ...course,
          // Section titles only matter for special topics; regular courses use
          // the catalog title (the page's title column is sometimes wrong).
          title:
            course.number || SPECIAL_TOPICS.test(course.courseNumber)
              ? title || undefined
              : undefined,
          pageTitle: title || undefined,
          instructors: names,
        });
        byTerm.set(key, draft);
      });
    });
  return [...byTerm.values()];
};

/** Fetch and parse every EECS draft schedule page into per-term drafts. */
export const scrapeEecsDraftSchedules = async (
  log: Config["log"]
): Promise<DraftTerm[]> => {
  const merged = new Map<string, DraftTerm>();
  for (const url of EECS_DRAFT_PAGES) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    const terms = parseDraftPage(await response.text(), url);
    log.info(
      `Parsed ${url}: ${terms.map((t) => `${t.semester} ${t.year} (${t.courses.length})`).join(", ") || "no terms"}`
    );
    for (const term of terms) {
      const key = termName(term.year, term.semester);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, term);
        continue;
      }
      // Pages cross-list a few courses (e.g. CS 270 on the EE page); dedupe.
      const seen = new Set(
        existing.courses.map((c) => `${c.subject} ${c.courseNumber} ${c.number ?? ""}`)
      );
      for (const course of term.courses) {
        const k = `${course.subject} ${course.courseNumber} ${course.number ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        existing.courses.push(course);
      }
      existing.sources.push(...term.sources);
    }
  }
  return [...merged.values()];
};

const countRealClasses = (year: number, semester: string) =>
  ClassModel.countDocuments({ year, semester, isDraft: { $ne: true } });

/** Rebuild catalog_classes for a term from the class/section/course docs. */
const rebuildTermCatalog = async (
  log: Config["log"],
  year: number,
  semester: string
) => {
  const docs = await buildCatalogClasses(year, semester);
  await CatalogClassModel.deleteMany({ year, semester });
  const BATCH_SIZE = 2000;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    await CatalogClassModel.insertMany(docs.slice(i, i + BATCH_SIZE), {
      ordered: false,
    });
  }
  await updateCatalogRmpRatings(log, year, semester);
  log.info(`Rebuilt ${docs.length} catalog classes for ${year} ${semester}`);
  return docs.length;
};

/**
 * Remove a term's draft rows and clear its draft flag. Returns true when
 * anything changed (caller should refresh catalog-wide sort fields + caches).
 */
const retireDraftTerm = async (
  log: Config["log"],
  year: number,
  semester: string
) => {
  const [classes, sections, terms] = await Promise.all([
    ClassModel.deleteMany({ year, semester, isDraft: true }),
    SectionModel.deleteMany({ year, semester, isDraft: true }),
    TermModel.updateMany(
      { name: termName(year, semester), isDraft: true },
      { $set: { isDraft: false } }
    ),
  ]);
  const changed =
    classes.deletedCount + sections.deletedCount + terms.modifiedCount > 0;
  if (!changed) return false;
  log.info(
    `Real schedule present for ${semester} ${year}: removed ${classes.deletedCount} draft classes, ` +
      `${sections.deletedCount} draft sections; cleared draft flag on ${terms.modifiedCount} term doc(s)`
  );
  await rebuildTermCatalog(log, year, semester);
  return true;
};

/** Ensure a UGRD term row exists for a draft term SIS hasn't created yet. */
const ensureTermDoc = async (
  log: Config["log"],
  year: number,
  semester: string
) => {
  const name = termName(year, semester);
  const existing = await TermModel.findOne({
    name,
    academicCareerCode: "UGRD",
  }).lean();
  if (existing) return existing;

  // Approximate instructional dates; replaced by the real SIS term later.
  const [beginDate, endDate] =
    semester === "Fall"
      ? [`${year}-08-19`, `${year}-12-18`]
      : semester === "Spring"
        ? [`${year}-01-12`, `${year}-05-15`]
        : [`${year}-05-26`, `${year}-08-14`];
  const doc = {
    academicCareerCode: "UGRD",
    temporalPosition: "Future" as const,
    id: termIdFor(year, semester),
    name,
    academicYear: String(semester === "Fall" ? year + 1 : year),
    beginDate,
    endDate,
    sessions: [
      {
        temporalPosition: "Future" as const,
        id: "1",
        name: "Regular Academic Session",
        beginDate,
        endDate,
      },
    ],
    hasCatalogData: true,
    isDraft: true,
  };
  await TermModel.create(doc);
  log.info(`Created placeholder term row for ${name} (not in SIS yet)`);
  return doc;
};

/** 200+ catalog number => graduate. Strips leading letters (C/H/W/R...). */
const inferCareer = (courseNumber: string): string => {
  const m = courseNumber.match(/\d+/);
  return m && parseInt(m[0], 10) >= 200 ? "GRAD" : "UGRD";
};

const unitsFromCredit = (
  credit:
    | {
        value?: {
          fixed?: number;
          range?: { minUnits?: number; maxUnits?: number };
        };
      }
    | undefined
): { minimum: number; maximum: number } | undefined => {
  const v = credit?.value;
  if (!v) return undefined;
  if (typeof v.fixed === "number")
    return { minimum: v.fixed, maximum: v.fixed };
  if (v.range && (v.range.minUnits != null || v.range.maxUnits != null)) {
    return {
      minimum: v.range.minUnits ?? 0,
      maximum: v.range.maxUnits ?? v.range.minUnits ?? 0,
    };
  }
  return undefined;
};

const parseInstructor = (raw: string) => {
  const comma = raw.indexOf(",");
  const [familyName, givenName] =
    comma >= 0
      ? [raw.slice(0, comma).trim(), raw.slice(comma + 1).trim()]
      : [raw.trim(), ""];
  return {
    printInScheduleOfClasses: true,
    familyName,
    givenName,
    role: "PI",
  };
};

/** Replace a term's draft rows with the given draft and rebuild its catalog. */
const seedDraftTerm = async (log: Config["log"], draft: DraftTerm) => {
  const { year, semester } = draft;
  const termDoc = await ensureTermDoc(log, year, semester);
  const termId = termDoc.id;
  const session =
    termDoc.sessions?.find((s) => s.id === "1") ?? termDoc.sessions?.[0];
  const startDate = session?.beginDate ?? termDoc.beginDate;
  const endDate = session?.endDate ?? termDoc.endDate;

  await ClassModel.deleteMany({ year, semester, isDraft: true });
  await SectionModel.deleteMany({ year, semester, isDraft: true });

  const classDocs: Record<string, unknown>[] = [];
  const sectionDocs: Record<string, unknown>[] = [];
  // Class numbers already used per courseId — avoids section-map collisions
  // when two subjects share one courseId (cross-listings).
  const usedNumbers = new Map<string, Set<string>>();

  for (const entry of draft.courses) {
    const { subject, courseNumber } = entry;
    // A (subject, number) pair can map to several Course docs (renumbered or
    // retired courses keep their own courseId); prefer the catalog-visible,
    // active one so the class isn't dropped from the catalog.
    const candidates = await CourseModel.find({
      subject,
      number: courseNumber,
    }).lean();
    const existing =
      candidates.find(
        (c) => c.printInCatalog === true && c.status === "ACTIVE"
      ) ??
      candidates.find((c) => c.printInCatalog === true) ??
      candidates.find((c) => c.status === "ACTIVE") ??
      candidates[0];

    let courseId: string;
    let component = "LEC";
    let allowedUnits: { minimum: number; maximum: number } | undefined;
    let gradingBasis = "OPT";
    let finalExam: string | undefined;

    if (existing) {
      courseId = existing.courseId;
      component = existing.primaryInstructionMethod || "LEC";
      allowedUnits = unitsFromCredit(existing.credit);
      gradingBasis = existing.gradingBasis ?? gradingBasis;
      finalExam = existing.finalExam;
    } else {
      courseId = `draft-${subject}-${courseNumber}`;
      await CourseModel.updateOne(
        { courseId },
        {
          $set: {
            courseId,
            subject,
            number: courseNumber,
            title:
              entry.title || entry.pageTitle || `${subject} ${courseNumber}`,
            academicCareer: inferCareer(courseNumber),
            academicOrganization: "ELENG",
            status: "ACTIVE",
            printInCatalog: true,
            gradingBasis,
          },
        },
        { upsert: true }
      );
    }

    const used = usedNumbers.get(courseId) ?? new Set<string>();
    let number = entry.number;
    if (!number || used.has(number)) {
      let n = 1;
      while (used.has(String(n).padStart(3, "0"))) n += 1;
      number = String(n).padStart(3, "0");
    }
    used.add(number);
    usedNumbers.set(courseId, used);

    const instructors = entry.instructors.map(parseInstructor);

    classDocs.push({
      courseId,
      courseNumber,
      year,
      semester,
      subject,
      termId,
      sessionId: "1",
      number,
      title: entry.title,
      allowedUnits,
      gradingBasis,
      status: "A",
      finalExam,
      instructionMode: "P",
      anyPrintInScheduleOfClasses: true,
      isDraft: true,
    });

    sectionDocs.push({
      termId,
      sessionId: "1",
      sectionId: `d-${subject}-${courseNumber}-${number}`,
      courseId,
      classNumber: number,
      subject,
      courseNumber,
      number,
      primary: true,
      year,
      semester,
      component,
      status: "A",
      instructionMode: "P",
      printInScheduleOfClasses: true,
      startDate,
      endDate,
      meetings: [
        {
          number: 1,
          days: Array(DAY_COUNT).fill(false),
          startDate,
          endDate,
          instructors,
        },
      ],
      isDraft: true,
    });
  }

  await ClassModel.insertMany(classDocs);
  await SectionModel.insertMany(sectionDocs);
  await TermModel.updateMany(
    { name: termName(year, semester) },
    { $set: { hasCatalogData: true, isDraft: true } }
  );
  log.info(
    `Seeded ${classDocs.length} tentative EECS classes for ${semester} ${year}`
  );
  await rebuildTermCatalog(log, year, semester);
};

/** True when the term's draft rows already match the snapshot (no reseed). */
const isDraftCurrent = async (draft: DraftTerm) => {
  const [term, count] = await Promise.all([
    TermModel.findOne({
      name: termName(draft.year, draft.semester),
      isDraft: true,
    }).lean(),
    ClassModel.countDocuments({
      year: draft.year,
      semester: draft.semester,
      isDraft: true,
    }),
  ]);
  return !!term && count === draft.courses.length;
};

/**
 * Reconcile tentative EECS terms with the DB:
 *  - term has a real schedule  -> drop draft rows, clear draft flag
 *  - term is in the past       -> skip
 *  - otherwise                 -> (re)seed draft rows if missing/stale
 *
 * `refetch: true` scrapes EECS and stores the snapshot (daily puller);
 * `refetch: false` reuses the stored snapshot (after backup merges), only
 * scraping when none exists yet. `force` reseeds even if rows look current.
 * `syncCatalog: false` skips the catalog-wide sort-field/enrollment refresh
 * (for callers that run it themselves afterwards).
 *
 * Returns true when the DB changed.
 */
export const syncDraftSchedules = async (
  log: Config["log"],
  {
    refetch,
    force = false,
    syncCatalog = true,
  }: { refetch: boolean; force?: boolean; syncCatalog?: boolean }
): Promise<boolean> => {
  let drafts: DraftTerm[];
  const stored = refetch
    ? []
    : await DraftScheduleSnapshotModel.find().lean();
  if (stored.length) {
    drafts = stored;
  } else {
    drafts = await scrapeEecsDraftSchedules(log);
    if (drafts.length) {
      await DraftScheduleSnapshotModel.deleteMany({});
      await DraftScheduleSnapshotModel.insertMany(
        drafts.map((d) => ({
          ...d,
          name: termName(d.year, d.semester),
          fetchedAt: new Date(),
        }))
      );
    }
  }

  // Any draft term no longer on the EECS page (and not covered above) still
  // needs retiring once its real schedule lands.
  const draftTermNames = new Set(drafts.map((d) => termName(d.year, d.semester)));
  const orphanDraftTerms = (
    await TermModel.distinct("name", { isDraft: true })
  ).filter((name) => !draftTermNames.has(name));

  let changed = false;
  for (const name of orphanDraftTerms) {
    const [year, semester] = [Number(name.split(" ")[0]), name.split(" ")[1]];
    if ((await countRealClasses(year, semester)) >= MIN_REAL_CLASSES) {
      changed = (await retireDraftTerm(log, year, semester)) || changed;
    }
  }

  for (const draft of drafts) {
    const { year, semester } = draft;
    const label = `${semester} ${year}`;
    if ((await countRealClasses(year, semester)) >= MIN_REAL_CLASSES) {
      log.info(`${label}: full schedule released; draft not needed`);
      changed = (await retireDraftTerm(log, year, semester)) || changed;
      continue;
    }
    const term = await TermModel.findOne({
      name: termName(year, semester),
      academicCareerCode: "UGRD",
    }).lean();
    if (term?.temporalPosition === "Past") {
      log.info(`${label}: term is in the past; skipping draft`);
      continue;
    }
    if (!draft.courses.length) continue;
    if (!force && (await isDraftCurrent(draft))) {
      log.info(`${label}: tentative EECS schedule already loaded`);
      continue;
    }
    await seedDraftTerm(log, draft);
    changed = true;
  }

  if (changed && syncCatalog) {
    await updateCatalogGradeSummaries(log);
    await updateCatalogRatingsForAllCatalogTerms(log);
    await syncCatalogEnrollmentForAllCatalogTerms(log);
  }
  return changed;
};
