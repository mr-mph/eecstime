import { useMemo } from "react";

import classNames from "classnames";

import {
  filterLsBreadthRequirements,
  filterUniversityRequirementLabels,
  getEecsHumanitiesBreadthsMet,
  meetsEecsEthics,
  meetsEecsHumanitiesSocialSciences,
} from "@repo/shared";
import { Badge, Box, Container, Flex } from "@repo/theme";

import Details from "@/components/Details";
import useClass from "@/hooks/useClass";
import { getDerivedFinalExam } from "@/lib/finalExam";
import { DeCal, DeCalInstructor } from "@/lib/generated/graphql";
import { linkify } from "@/utils/linkify";

import Articulations from "./Articulations";
import styles from "./Overview.module.scss";
import TargetedMessageBanner from "./TargetedMessageBanner";
import { UserSubmittedData } from "./UserSubmittedData";

const formatApplicationDeadline = (value: string): string => {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return value;
};

const FINAL_EXAM_LABELS: Record<string, string> = {
  Y: "Written final exam during scheduled final exam period",
  N: "No final exam",
  A: "Alternative method of final assessment",
  C: "Common final exam",
  L: "Final exam at last class meeting",
};

const formatExamTime = (startTime?: string | null, endTime?: string | null) => {
  if (!startTime || !endTime) return null;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  if (!Number.isFinite(sh) || !Number.isFinite(eh)) return null;
  const fmt = (h: number, m: number) =>
    `${h % 12 || 12}${m > 0 ? `:${m.toString().padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
  return `${fmt(sh, sm)} – ${fmt(eh, em)}`;
};

const formatExamDate = (dateStr?: string | null): string | null => {
  if (!dateStr) return null;
  let date: Date;
  if (/^\d{8}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    date = new Date(y, m, d);
  } else {
    // Parse ISO dates as local time; new Date("YYYY-MM-DD") is UTC
    // midnight, which formats as the previous day in western timezones.
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    date = match
      ? new Date(
          parseInt(match[1], 10),
          parseInt(match[2], 10) - 1,
          parseInt(match[3], 10)
        )
      : new Date(dateStr);
  }
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

export default function Overview() {
  const { class: _class, course } = useClass();
  const decal: DeCal | null = _class?.decal ?? null;

  const sectionAttributes = useMemo(
    () => _class.primarySection?.sectionAttributes ?? [],
    [_class.primarySection?.sectionAttributes]
  );

  const geRequirementLabels = useMemo(() => {
    const geAttributes = _class.primarySection?.geAttributes ?? [];
    return geAttributes
      .map((attribute) => attribute.value?.description?.trim() ?? "")
      .filter(Boolean);
  }, [_class.primarySection?.geAttributes]);

  const breadthRequirements = useMemo(
    () => filterLsBreadthRequirements(geRequirementLabels),
    [geRequirementLabels]
  );

  const universityRequirements = useMemo(() => {
    const fromDesignation =
      _class.requirementDesignation?.description?.trim() ||
      _class.requirementDesignation?.formalDescription?.trim();
    const fromGe = filterUniversityRequirementLabels(geRequirementLabels);
    const combined = new Set<string>([
      ...(fromDesignation ? [fromDesignation] : []),
      ...fromGe,
    ]);
    return Array.from(combined);
  }, [_class.requirementDesignation, geRequirementLabels]);

  const humanitiesBreadthsMet = useMemo(
    () => getEecsHumanitiesBreadthsMet(breadthRequirements),
    [breadthRequirements]
  );

  const meetsHumanitiesSocialSciences = useMemo(
    () => meetsEecsHumanitiesSocialSciences(breadthRequirements),
    [breadthRequirements]
  );

  const meetsEthics = useMemo(
    () => meetsEecsEthics(_class.subject, _class.courseNumber),
    [_class.subject, _class.courseNumber]
  );

  const hasRequirementsMet =
    universityRequirements.length > 0 ||
    breadthRequirements.length > 0 ||
    meetsHumanitiesSocialSciences ||
    meetsEthics;

  const prereqs = useMemo(() => {
    if (course.requirements && course.requirements.trim()) {
      return course.requirements;
    }
    return null;
  }, [course.requirements]);

  const classDescription = useMemo(() => {
    if (decal?.description?.trim()) {
      return decal.description;
    }
    const classDescriptionAttribute = sectionAttributes.find(
      (attribute) =>
        attribute.attribute?.code === "NOTE" &&
        attribute.attribute?.formalDescription === "Class Description"
    );

    const text =
      classDescriptionAttribute?.value?.formalDescription?.trim() ??
      classDescriptionAttribute?.value?.description?.trim() ??
      null;

    return text ?? course.description ?? "";
  }, [course.description, decal?.description, sectionAttributes]);

  const classNoteLines = useMemo(() => {
    if (!sectionAttributes.length) return null;

    const classNotesAttribute = sectionAttributes.find(
      (attribute) =>
        attribute.attribute?.code === "NOTE" &&
        attribute.attribute?.formalDescription === "Class Notes"
    );

    const text =
      classNotesAttribute?.value?.formalDescription?.trim() ??
      classNotesAttribute?.value?.description?.trim() ??
      null;

    if (!text) return null;

    const normalize = (value: string): string =>
      value.replace(/\s+/g, " ").trim();

    const normalizedNoteText = normalize(text);
    const normalizedDescription = normalize(classDescription ?? "");
    const normalizedTitle = normalize(course.title ?? "");

    if (
      normalizedNoteText === normalizedDescription ||
      normalizedNoteText === normalizedTitle
    ) {
      return null;
    }

    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }, [classDescription, course.title, sectionAttributes]);

  const displayedDescription = useMemo(() => {
    const base = decal?.description ?? classDescription;
    const trimmed = base.trim();
    return trimmed.length > 0 ? trimmed : "No description provided.";
  }, [classDescription, decal?.description]);

  return (
    <Box p="5">
      <Container size="3">
        <Flex direction="column" gap="5">
          <TargetedMessageBanner courseId={_class.courseId} />
          {_class.primarySection?.meetings.map((meeting, i) => (
            <Details {...meeting} key={i} />
          ))}
          {decal &&
            (decal.applicationUrl ||
              decal.syllabusUrl ||
              decal.applicationDueDate) && (
              <Flex direction="column" gap="2">
                <p className={styles.label}>DeCal Application</p>
                <p className={styles.description}>
                  {decal.applicationUrl && (
                    <a
                      href={decal.applicationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.link}
                    >
                      Apply
                    </a>
                  )}
                  {decal.syllabusUrl && (
                    <>
                      {decal.applicationUrl ? " · " : null}
                      <a
                        href={decal.syllabusUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.link}
                      >
                        Syllabus
                      </a>
                    </>
                  )}
                  {decal.applicationDueDate && (
                    <>
                      {decal.applicationUrl || decal.syllabusUrl ? " · " : null}
                      <span>
                        Deadline:{" "}
                        {formatApplicationDeadline(decal.applicationDueDate)}
                      </span>
                    </>
                  )}
                </p>
              </Flex>
            )}
          {prereqs && (
            <Flex direction="column" gap="2">
              <p className={styles.label}>Prerequisites</p>
              <p className={styles.description}>{prereqs}</p>
            </Flex>
          )}
          {hasRequirementsMet && (
            <Flex direction="column" gap="2">
              <p className={styles.label}>Requirements Met</p>
              <div className={styles.requirementsGroups}>
                {universityRequirements.length > 0 && (
                  <div className={styles.requirementGroup}>
                    <p className={styles.requirementGroupLabel}>
                      University Requirements
                    </p>
                    <div className={styles.requirementTags}>
                      {universityRequirements.map((requirement) => (
                        <Badge
                          key={requirement}
                          label={requirement}
                          color="blue"
                          variant="border"
                        />
                      ))}
                    </div>
                  </div>
                )}
                {breadthRequirements.length > 0 && (
                  <div className={styles.requirementGroup}>
                    <p className={styles.requirementGroupLabel}>
                      L&S Breadths
                    </p>
                    <div className={styles.requirementTags}>
                      {breadthRequirements.map((breadth) => (
                        <Badge
                          key={breadth}
                          label={breadth}
                          color="purple"
                          variant="border"
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div className={styles.requirementGroup}>
                  <p className={styles.requirementGroupLabel}>EECS</p>
                  <div className={styles.requirementStatusList}>
                    <div className={styles.requirementStatusRow}>
                      <span className={styles.requirementStatusName}>
                        Humanities/Social Sciences
                      </span>
                      <span
                        className={classNames(styles.requirementStatusValue, {
                          [styles.requirementStatusValueYes]:
                            meetsHumanitiesSocialSciences,
                          [styles.requirementStatusValueNo]:
                            !meetsHumanitiesSocialSciences,
                        })}
                      >
                        {meetsHumanitiesSocialSciences ? "Yes" : "No"}
                        {meetsHumanitiesSocialSciences &&
                          humanitiesBreadthsMet.length > 0 && (
                            <span className={styles.requirementStatusDetail}>
                              {" "}
                              ({humanitiesBreadthsMet.join(", ")})
                            </span>
                          )}
                      </span>
                    </div>
                    <div className={styles.requirementStatusRow}>
                      <span className={styles.requirementStatusName}>
                        Ethics
                      </span>
                      <span
                        className={classNames(styles.requirementStatusValue, {
                          [styles.requirementStatusValueYes]: meetsEthics,
                          [styles.requirementStatusValueNo]: !meetsEthics,
                        })}
                      >
                        {meetsEthics ? "Yes" : "No"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </Flex>
          )}
          <Flex direction="column" gap="2">
            <p className={styles.label}>Description</p>
            <p className={styles.description}>{displayedDescription}</p>
          </Flex>
          <Articulations />
          {classNoteLines && classNoteLines.length > 0 && (
            <Flex direction="column" gap="2">
              <p className={styles.label}>Class Notes</p>
              <p className={styles.description}>
                {classNoteLines.map((line, index) => (
                  <span key={`${line}-${index}`}>
                    {linkify(line, styles.link)}
                    {index < classNoteLines.length - 1 && <br />}
                  </span>
                ))}
              </p>
            </Flex>
          )}
          {(() => {
            const exams = _class.primarySection?.exams ?? [];
            const finalExamCode = _class.finalExam;
            const finalExamLabel =
              finalExamCode && FINAL_EXAM_LABELS[finalExamCode];
            const finalExamsWithSchedule = exams
              .filter((e) => e.type === "FIN")
              .filter((e) => e.date || e.startTime || e.endTime);
            const hasScheduledExams = finalExamsWithSchedule.length > 0;
            const derivedExam = hasScheduledExams
              ? null
              : getDerivedFinalExam(_class);
            if (!finalExamLabel && !hasScheduledExams && !derivedExam)
              return null;
            return (
              <Flex direction="column" gap="2">
                <p className={styles.label}>Final Exam</p>
                <p className={styles.description}>
                  {finalExamLabel && <span>{finalExamLabel}</span>}
                  {hasScheduledExams &&
                    finalExamsWithSchedule.map((exam, i) => {
                      const dateStr = formatExamDate(exam.date);
                      const timeStr = formatExamTime(
                        exam.startTime,
                        exam.endTime
                      );
                      const parts = [
                        dateStr,
                        timeStr,
                        exam.location?.trim(),
                      ].filter(Boolean);
                      const line = parts.join(" · ");
                      return (
                        <span key={i}>
                          {i > 0 || finalExamLabel ? <br /> : null}
                          {line}
                        </span>
                      );
                    })}
                  {derivedExam &&
                    (() => {
                      const dateStr = formatExamDate(derivedExam.date);
                      const timeStr = formatExamTime(
                        derivedExam.startTime,
                        derivedExam.endTime
                      );
                      if (!dateStr || !timeStr) return null;
                      return (
                        <span>
                          {finalExamLabel ? <br /> : null}
                          {dateStr} · {timeStr} (predicted)
                        </span>
                      );
                    })()}
                </p>
              </Flex>
            );
          })()}
          {decal && decal.instructors && decal.instructors.length > 0 && (
            <Flex direction="column" gap="2">
              <p className={styles.label}>Contact Information</p>
              <p className={styles.description}>
                {decal.instructors.map((inst: DeCalInstructor, i: number) => (
                  <span key={i}>
                    {inst.name && <span>{inst.name}: </span>}
                    {inst.email ? (
                      <a href={`mailto:${inst.email}`} className={styles.link}>
                        {inst.email}
                      </a>
                    ) : null}
                    {!inst.email && !inst.name && null}
                    {i < decal.instructors!.length - 1 && ", "}
                  </span>
                ))}
              </p>
            </Flex>
          )}
          <UserSubmittedData />
        </Flex>
      </Container>
    </Box>
  );
}
