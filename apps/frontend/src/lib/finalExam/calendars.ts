/**
 * Per-term final exam calendars published by the Office of the Registrar.
 * https://registrar.berkeley.edu/faculty-staff-resources/aacademic-classroom-scheduling/final-exam-scheduling/
 *
 * calendars.json is refreshed from that page by
 * `npm run update-final-exam-calendars` (also before `dev` and `build`).
 * Terms are keyed by "<year> <semester>" (e.g. "2027 Spring").
 */
import generatedCalendars from "./calendars.json";

/** A concrete exam sitting from the registrar's calendar. */
export interface FinalExamSlot {
  /** Exam group number in the registrar's table. */
  group: number;
  /** ISO date, e.g. "2026-12-14". */
  date: string;
  /** 24-hour "HH:MM". */
  startTime: string;
  /** 24-hour "HH:MM". */
  endTime: string;
}

/**
 * Day-pattern category from the registrar's table. Per the registrar,
 * classes meeting on M, W, F, MW, MF, WF, or MTWTF follow the "MWF"
 * groups; classes meeting on Tu, Th, or TuTh follow the "TuTh" groups.
 */
export type FinalExamDayCategory = "MWF" | "TuTh";

/** Maps a day category + class start time to an exam group. */
export interface StartTimeRule {
  category: FinalExamDayCategory;
  /** Exact class start times ("HH:MM") this rule covers. */
  startTimes?: string[];
  /** Covers classes starting at or after this time ("HH:MM"). */
  startAtOrAfter?: string;
  group: number;
}

/** Assigns specific courses to a group regardless of meeting time. */
export interface CourseRule {
  subject: string;
  courseNumbers: string[];
  group: number;
}

export interface TermFinalExamCalendar {
  slots: FinalExamSlot[];
  startTimeRules: StartTimeRule[];
  courseRules: CourseRule[];
  /** Group for online/web-based instruction mode classes. */
  onlineGroup?: number;
  /** Group for classes meeting on Saturday or Sunday. */
  weekendGroup?: number;
}

/**
 * Elementary foreign-language classes are listed in some exam groups, but
 * the registrar says not every language class is included and to check with
 * the instructor. They are not encoded; those classes use their day/time
 * group instead.
 *
 * Keyed by "<year> <semester>", e.g. "2026 Fall".
 */
export const FINAL_EXAM_CALENDARS = generatedCalendars as Record<
  string,
  TermFinalExamCalendar
>;
