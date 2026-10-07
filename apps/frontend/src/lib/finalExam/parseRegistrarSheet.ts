import type { TermFinalExamCalendar } from "./calendars";

/** Registrar page that embeds the current spring and fall exam-group sheets. */
export const REGISTRAR_FINAL_EXAM_URL =
  "https://registrar.berkeley.edu/faculty-staff-resources/aacademic-classroom-scheduling/final-exam-scheduling/";

const SUBJECT_ALIASES: Record<string, string> = {
  STATS: "STAT",
};

const STOP_WORDS = new Set([
  "and",
  "all",
  "saturday",
  "sunday",
  "online",
  "courses",
  "course",
  "elementary",
  "foreign",
  "languages",
  "language",
  "am",
  "pm",
  "mwf",
  "mtwtf",
  "tuth",
]);

export interface ParsedTermCalendar {
  /** "<year> <semester>", e.g. "2027 Spring". */
  key: string;
  calendar: TermFinalExamCalendar;
}

/** Parse a quoted Google Sheets CSV export into rows. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

const pad = (value: number) => String(value).padStart(2, "0");

const to24Hour = (hour: number, minute: number, meridiem: string) => {
  let hours = hour;
  if (meridiem === "am") {
    if (hours === 12) hours = 0;
  } else if (hours !== 12) {
    hours += 12;
  }
  return `${pad(hours)}:${pad(minute)}`;
};

const parseClockRange = (time: string) => {
  const match = time
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*[–-]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) {
    throw new Error(`Unrecognized exam time "${time}"`);
  }
  const startHour = Number(match[1]);
  const startMinute = Number(match[2] ?? 0);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4] ?? 0);
  const meridiem = match[5].toLowerCase();
  // "11:30–2:30 pm" crosses noon: the start is still morning.
  const startMeridiem = startHour > endHour && meridiem === "pm" ? "am" : meridiem;
  return {
    startTime: to24Hour(startHour, startMinute, startMeridiem),
    endTime: to24Hour(endHour, endMinute, meridiem),
  };
};

const parseDate = (date: string, yearFromTitle: number) => {
  const match = date.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error(`Unrecognized exam date "${date}"`);
  const [, month, day, year] = match;
  if (Number(year) !== yearFromTitle) {
    throw new Error(`Exam date ${date} does not match calendar year ${yearFromTitle}`);
  }
  return `${year}-${pad(Number(month))}-${pad(Number(day))}`;
};

const parseStartTimes = (text: string) => {
  const after = text.match(/at or after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (after) {
    return {
      startAtOrAfter: to24Hour(
        Number(after[1]),
        Number(after[2] ?? 0),
        after[3].toLowerCase()
      ),
    };
  }

  const meridiemMatch = text.match(/(am|pm)\s*$/i);
  if (!meridiemMatch) {
    throw new Error(`Unrecognized class start times "${text}"`);
  }
  const meridiem = meridiemMatch[1].toLowerCase();
  const times = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?/g)].map((match) => ({
    hour: Number(match[1]),
    minute: Number(match[2] ?? 0),
  }));
  if (times.length === 0) {
    throw new Error(`Unrecognized class start times "${text}"`);
  }
  return {
    startTimes: times.map((time) =>
      to24Hour(time.hour, time.minute, meridiem)
    ),
  };
};

const normalizeCourseNumber = (token: string) => token.toUpperCase();

const isCourseNumber = (token: string) => /^[A-Z]{0,2}\d+[A-Z]?$/i.test(token);

const isSubject = (token: string) =>
  /^[A-Za-z]{2,}$/.test(token) && !STOP_WORDS.has(token.toLowerCase());

const parseCourseClause = (clause: string, group: number) => {
  const tokens = clause
    .replace(/&/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  const rules: TermFinalExamCalendar["courseRules"] = [];
  let subject: string | null = null;
  let courseNumbers: string[] = [];

  const flush = () => {
    if (!subject || courseNumbers.length === 0) return;
    rules.push({ subject, courseNumbers, group });
    courseNumbers = [];
  };

  for (const token of tokens) {
    if (isSubject(token) && !isCourseNumber(token)) {
      flush();
      const upper = token.toUpperCase();
      subject = SUBJECT_ALIASES[upper] ?? upper;
      continue;
    }
    if (subject && isCourseNumber(token)) {
      courseNumbers.push(normalizeCourseNumber(token));
    }
  }
  flush();
  return rules;
};

const applyClause = (
  clause: string,
  group: number,
  calendar: TermFinalExamCalendar
) => {
  const cleaned = clause
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return;
  if (/online courses?/i.test(cleaned) || /foreign language/i.test(cleaned)) {
    if (/online courses?/i.test(cleaned)) calendar.onlineGroup = group;
    const rest = cleaned
      .replace(/online courses?/gi, "")
      .replace(/elementary foreign languages?/gi, "")
      .replace(/&/g, "")
      .trim();
    if (!rest) return;
  }

  const dayMatch = cleaned.match(/^(MWF(?:\s*&\s*MTWTF)?|TuTh),\s*(.+)$/i);
  if (dayMatch) {
    const category = dayMatch[1].toLowerCase().startsWith("mwf") ? "MWF" : "TuTh";
    let rest = dayMatch[2];
    if (/saturday|sunday/i.test(rest)) {
      calendar.weekendGroup = group;
      rest = rest.replace(/and all saturday\s*(?:&|and)\s*sunday/i, "").trim();
    }
    if (!rest) return;
    const times = parseStartTimes(rest);
    calendar.startTimeRules.push({ category, group, ...times });
    return;
  }

  calendar.courseRules.push(...parseCourseClause(cleaned, group));
};

/**
 * Parse one term's published exam-group sheet.
 * The first cell is a title like "Spring 2027 Final Examination Calendar".
 */
export const parseRegistrarCalendarCsv = (csv: string): ParsedTermCalendar => {
  const rows = parseCsv(csv);
  const title = rows[0]?.[0]?.trim() ?? "";
  const titleMatch = title.match(/^(Spring|Fall)\s+(\d{4})\b/i);
  if (!titleMatch) {
    throw new Error(`Unrecognized final exam calendar title "${title}"`);
  }
  const semester = titleMatch[1][0].toUpperCase() + titleMatch[1].slice(1).toLowerCase();
  const year = Number(titleMatch[2]);

  const calendar: TermFinalExamCalendar = {
    slots: [],
    startTimeRules: [],
    courseRules: [],
  };

  for (const row of rows.slice(1)) {
    const [groupCell, , dateCell, timeCell, descriptionCell] = row;
    if (!groupCell || !/^\d+$/.test(groupCell.trim())) continue;
    const group = Number(groupCell.trim());
    calendar.slots.push({
      group,
      date: parseDate(dateCell ?? "", year),
      ...parseClockRange(timeCell ?? ""),
    });
    for (const clause of (descriptionCell ?? "").split(";")) {
      applyClause(clause, group, calendar);
    }
  }

  if (calendar.slots.length === 0) {
    throw new Error(`No exam groups found in "${title}"`);
  }

  return { key: `${year} ${semester}`, calendar };
};
