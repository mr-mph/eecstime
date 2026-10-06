import { sortByTermDescending } from "@/lib/classes";
import { Semester } from "@/lib/generated/graphql";

export interface EnrollmentUrlInput {
  subject: string;
  courseNumber: string;
  year: number;
  semester: Semester;
  sectionNumber: string;
  sessionId?: string;
}

const parseInputString = (inputString: string): EnrollmentUrlInput | null => {
  const parts = inputString.split(";");
  if (parts.length < 5) return null;

  const [subject, courseNumber, typeToken, termString, sectionNumber] = parts;
  if (!subject || !courseNumber || !termString || !sectionNumber) return null;
  if (typeToken !== "T") return null;

  const termParts = termString.split(":");
  if (termParts.length < 2) return null;

  const [rawYear, rawSemester, rawSessionId] = termParts;
  if (!rawYear || !rawSemester) return null;

  const year = Number.parseInt(rawYear, 10);
  if (Number.isNaN(year)) return null;

  return {
    subject,
    courseNumber,
    year,
    semester: rawSemester as Semester,
    sectionNumber,
    sessionId: rawSessionId || undefined,
  };
};

export const isEnrollmentInputEqual = (
  a: EnrollmentUrlInput,
  b: EnrollmentUrlInput
) =>
  a.subject === b.subject &&
  a.courseNumber === b.courseNumber &&
  a.year === b.year &&
  a.semester === b.semester &&
  a.sessionId === b.sessionId &&
  a.sectionNumber === b.sectionNumber;

export const getEnrollmentInputSearchParam = (input: EnrollmentUrlInput) => {
  const termParts = [`${input.year}`, input.semester];
  if (input.sessionId) termParts.push(input.sessionId);

  return `${input.subject};${input.courseNumber};T;${termParts.join(":")};${input.sectionNumber}`;
};

export const getEnrollmentInputId = (input: EnrollmentUrlInput) =>
  `${input.subject}-${input.courseNumber}-${input.year}-${input.semester}-${input.sessionId ?? "1"}-${input.sectionNumber}`;

export const parseEnrollmentInputsFromUrl = (
  searchParams: URLSearchParams
): EnrollmentUrlInput[] => {
  const parsed = searchParams
    .getAll("input")
    .map(parseInputString)
    .filter((input): input is EnrollmentUrlInput => input !== null);

  return parsed.filter(
    (input, index, allInputs) =>
      allInputs.findIndex((candidate) =>
        isEnrollmentInputEqual(candidate, input)
      ) === index
  );
};

export interface EnrollmentSectionCandidate {
  year: number;
  semester: string;
  sessionId?: string | null;
  number: string;
  primarySection?: {
    number?: string | null;
    enrollment?: {
      latest?: unknown | null;
    } | null;
  } | null;
}

const sectionNumberOf = (courseClass: EnrollmentSectionCandidate) =>
  courseClass.primarySection?.number ?? courseClass.number;

export const hasEnrollmentLatest = (courseClass: EnrollmentSectionCandidate) =>
  Boolean(
    sectionNumberOf(courseClass) &&
      courseClass.primarySection?.enrollment?.latest
  );

// Most recent semester first. Within a semester, lowest section number first.
export const listEnrollmentSectionCandidates = <
  T extends EnrollmentSectionCandidate,
>(
  classes: T[]
): T[] => {
  const withData = classes.filter(hasEnrollmentLatest);
  const terms = withData
    .filter(
      (courseClass, index, allClasses) =>
        allClasses.findIndex(
          (candidate) =>
            candidate.year === courseClass.year &&
            candidate.semester === courseClass.semester
        ) === index
    )
    .toSorted(sortByTermDescending);

  return terms.flatMap((term) =>
    withData
      .filter(
        (courseClass) =>
          courseClass.year === term.year &&
          courseClass.semester === term.semester
      )
      .toSorted((a, b) => {
        const bySection = sectionNumberOf(a).localeCompare(
          sectionNumberOf(b),
          undefined,
          { numeric: true }
        );
        if (bySection !== 0) return bySection;
        return (a.sessionId ?? "").localeCompare(b.sessionId ?? "");
      })
  );
};

export const enrollmentInputFromCandidate = (
  subject: string,
  courseNumber: string,
  courseClass: EnrollmentSectionCandidate
): EnrollmentUrlInput | null => {
  const sectionNumber = courseClass.primarySection?.number;
  if (!sectionNumber) return null;

  return {
    subject,
    courseNumber,
    year: courseClass.year,
    semester: courseClass.semester as Semester,
    sectionNumber,
    sessionId: courseClass.sessionId || undefined,
  };
};
