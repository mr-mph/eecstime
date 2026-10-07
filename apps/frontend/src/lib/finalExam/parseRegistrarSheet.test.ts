import { describe, expect, it } from "vitest";

import { parseRegistrarCalendarCsv } from "./parseRegistrarSheet";

const FALL_2026_CSV = `Fall 2026 Final Examination Calendar,,,,
Exam Group,Day,Date,Time,For Class Start Times
1,Monday,12/14/2026,8–11 am,"MWF & MTWTF, 10 am"
3,Monday,12/14/2026,3–6 pm,"Chem 1A, 1B, 3A, 3B, 4A, & 4B, 32, Econ 140"
6,Tuesday,12/15/2026,11:30–2:30 pm,"Econ 1 & 100B, UGBA 101B, 
DATA C8"
11,Wednesday,12/16/2026,3–6 pm,"TuTh, 8 am and all Saturday & Sunday"
12,Wednesday,12/16/2026,7–10 pm,"MWF & MTWTF, 1 pm;
**STATS 20**"
19,Friday,12/18/2026,3–6 pm,"TuTh, 10 am; 
MWF, at or after 5 pm;
English 1A, 1B, R1A, & R1B"
`;

const SPRING_2027_CSV = `Spring 2027 Final Examination Calendar,,,,
Exam Group,Day,Date,Time,For Class Start Times
1,Monday,5/10/2027,8–11 am,"MWF & MTWTF, 8 am"
2,Monday,5/10/2027,11:30–2:30 pm,"TuTh, 2 pm"
9,Wednesday,5/12/2027,8–11 am,"Chem 1A, 1B, 3A, 3B, 4A, & 4B, 32, ECON 140"
14,Thursday,5/13/2027,11:30–2:30 pm,Online courses* & Elementary Foreign Languages**
16,Thursday,5/13/2027,7–10 pm,"TuTh, 8 am and all Saturday & Sunday; 
**Stat 20**"
18,Friday,5/14/2027,11:30–2:30 pm,"TuTh, at or after 5 pm"
`;

describe("parseRegistrarCalendarCsv", () => {
  it("parses Fall 2026 groups, courses, and weekend exams", () => {
    const { key, calendar } = parseRegistrarCalendarCsv(FALL_2026_CSV);

    expect(key).toBe("2026 Fall");
    expect(calendar.slots.find((slot) => slot.group === 1)).toEqual({
      group: 1,
      date: "2026-12-14",
      startTime: "08:00",
      endTime: "11:00",
    });
    expect(calendar.slots.find((slot) => slot.group === 6)).toMatchObject({
      startTime: "11:30",
      endTime: "14:30",
    });
    expect(calendar.courseRules).toEqual(
      expect.arrayContaining([
        {
          subject: "CHEM",
          courseNumbers: ["1A", "1B", "3A", "3B", "4A", "4B", "32"],
          group: 3,
        },
        { subject: "ECON", courseNumbers: ["140"], group: 3 },
        { subject: "ECON", courseNumbers: ["1", "100B"], group: 6 },
        { subject: "UGBA", courseNumbers: ["101B"], group: 6 },
        { subject: "DATA", courseNumbers: ["C8"], group: 6 },
        { subject: "STAT", courseNumbers: ["20"], group: 12 },
        {
          subject: "ENGLISH",
          courseNumbers: ["1A", "1B", "R1A", "R1B"],
          group: 19,
        },
      ])
    );
    expect(calendar.startTimeRules).toEqual(
      expect.arrayContaining([
        { category: "MWF", startTimes: ["13:00"], group: 12 },
        { category: "TuTh", startTimes: ["08:00"], group: 11 },
        { category: "TuTh", startTimes: ["10:00"], group: 19 },
        { category: "MWF", startAtOrAfter: "17:00", group: 19 },
      ])
    );
    expect(calendar.weekendGroup).toBe(11);
  });

  it("parses the Spring 2027 sheet", () => {
    const { key, calendar } = parseRegistrarCalendarCsv(SPRING_2027_CSV);

    expect(key).toBe("2027 Spring");
    expect(calendar.slots.find((slot) => slot.group === 1)).toEqual({
      group: 1,
      date: "2027-05-10",
      startTime: "08:00",
      endTime: "11:00",
    });
    expect(calendar.onlineGroup).toBe(14);
    expect(calendar.weekendGroup).toBe(16);
    expect(calendar.courseRules).toEqual(
      expect.arrayContaining([
        { subject: "STAT", courseNumbers: ["20"], group: 16 },
        { subject: "ECON", courseNumbers: ["140"], group: 9 },
      ])
    );
    expect(calendar.startTimeRules).toEqual(
      expect.arrayContaining([
        { category: "MWF", startTimes: ["08:00"], group: 1 },
        { category: "TuTh", startAtOrAfter: "17:00", group: 18 },
      ])
    );
  });
});
