import { describe, expect, it } from "vitest";

import {
  FinalExamClassInput,
  finalExamsOverlap,
  formatFinalExamDate,
  formatFinalExamTime,
  getClassFinalExam,
  getDerivedFinalExam,
  getSisFinalExam,
} from ".";

// days: Monday-first [M, Tu, W, Th, F, Sa, Su]
const DAYS: Record<string, boolean[]> = {
  MWF: [true, false, true, false, true, false, false],
  MW: [true, false, true, false, false, false, false],
  WF: [false, false, true, false, true, false, false],
  M: [true, false, false, false, false, false, false],
  F: [false, false, false, false, true, false, false],
  TuTh: [false, true, false, true, false, false, false],
  Tu: [false, true, false, false, false, false, false],
  Th: [false, false, false, true, false, false, false],
  MTWTF: [true, true, true, true, true, false, false],
  MTuTh: [true, true, false, true, false, false, false],
  Sa: [false, false, false, false, false, true, false],
  Su: [false, false, false, false, false, false, true],
};

const makeClass = (
  overrides: Partial<FinalExamClassInput> & {
    days?: boolean[];
    startTime?: string;
    instructionMode?: string;
  } = {}
): FinalExamClassInput => {
  const { days, startTime, instructionMode, ...rest } = overrides;
  return {
    year: 2026,
    semester: "Fall",
    subject: "COMPSCI",
    courseNumber: "61A",
    primarySection: {
      instructionMode: instructionMode ?? "P",
      meetings: [
        {
          days: days ?? DAYS.MWF,
          startTime: startTime ?? "10:00:00",
        },
      ],
      exams: [],
    },
    ...rest,
  };
};

describe("getDerivedFinalExam", () => {
  describe("day/time rules (Fall 2026)", () => {
    const cases: [string, string, number, string, string][] = [
      // [days, startTime, expected group, expected date, expected exam start]
      ["MWF", "10:00:00", 1, "2026-12-14", "08:00"],
      ["MWF", "11:00:00", 2, "2026-12-14", "11:30"],
      ["MWF", "08:00:00", 4, "2026-12-14", "19:00"],
      ["TuTh", "14:00:00", 5, "2026-12-15", "08:00"],
      ["TuTh", "09:00:00", 7, "2026-12-15", "15:00"],
      ["TuTh", "09:30:00", 7, "2026-12-15", "15:00"],
      ["MWF", "15:00:00", 8, "2026-12-15", "19:00"],
      ["MWF", "15:30:00", 8, "2026-12-15", "19:00"],
      ["TuTh", "11:00:00", 9, "2026-12-16", "08:00"],
      ["TuTh", "08:00:00", 11, "2026-12-16", "15:00"],
      ["MWF", "13:00:00", 12, "2026-12-16", "19:00"],
      ["MWF", "16:00:00", 13, "2026-12-17", "08:00"],
      ["MWF", "16:30:00", 13, "2026-12-17", "08:00"],
      ["TuTh", "17:00:00", 14, "2026-12-17", "11:30"],
      ["TuTh", "18:30:00", 14, "2026-12-17", "11:30"],
      ["MWF", "14:00:00", 15, "2026-12-17", "15:00"],
      ["MWF", "09:00:00", 16, "2026-12-17", "19:00"],
      ["MWF", "09:30:00", 16, "2026-12-17", "19:00"],
      ["TuTh", "12:00:00", 17, "2026-12-18", "08:00"],
      ["TuTh", "12:30:00", 17, "2026-12-18", "08:00"],
      ["TuTh", "13:00:00", 17, "2026-12-18", "08:00"],
      ["MWF", "12:00:00", 18, "2026-12-18", "11:30"],
      ["MWF", "12:30:00", 18, "2026-12-18", "11:30"],
      ["TuTh", "10:00:00", 19, "2026-12-18", "15:00"],
      ["MWF", "17:00:00", 19, "2026-12-18", "15:00"],
      ["MWF", "19:00:00", 19, "2026-12-18", "15:00"],
      ["TuTh", "15:00:00", 20, "2026-12-18", "19:00"],
      ["TuTh", "15:30:00", 20, "2026-12-18", "19:00"],
      ["TuTh", "16:00:00", 20, "2026-12-18", "19:00"],
    ];

    it.each(cases)(
      "%s at %s -> group %i",
      (days, startTime, group, date, examStart) => {
        const exam = getDerivedFinalExam(
          makeClass({ days: DAYS[days], startTime })
        );
        expect(exam).toMatchObject({
          group,
          date,
          startTime: examStart,
          source: "derived",
        });
      }
    );

    it("treats M, W, F, MW, and WF patterns as MWF", () => {
      for (const days of [DAYS.M, DAYS.F, DAYS.MW, DAYS.WF]) {
        expect(
          getDerivedFinalExam(makeClass({ days, startTime: "10:00:00" }))
        ).toMatchObject({ group: 1 });
      }
    });

    it("treats Tu and Th alone as TuTh", () => {
      for (const days of [DAYS.Tu, DAYS.Th]) {
        expect(
          getDerivedFinalExam(makeClass({ days, startTime: "14:00:00" }))
        ).toMatchObject({ group: 5 });
      }
    });

    it("treats MTWTF as MWF", () => {
      expect(
        getDerivedFinalExam(
          makeClass({ days: DAYS.MTWTF, startTime: "09:00:00" })
        )
      ).toMatchObject({ group: 16 });
    });

    it("assigns Saturday and Sunday classes to the weekend group", () => {
      for (const days of [DAYS.Sa, DAYS.Su]) {
        expect(
          getDerivedFinalExam(makeClass({ days, startTime: "10:00:00" }))
        ).toMatchObject({ group: 11, date: "2026-12-16" });
      }
    });

    it("returns null for patterns the calendar does not cover", () => {
      expect(
        getDerivedFinalExam(
          makeClass({ days: DAYS.MTuTh, startTime: "10:00:00" })
        )
      ).toBeNull();
    });

    it("returns null for start times the calendar does not list", () => {
      // TuTh 10:30 is not in the registrar's table.
      expect(
        getDerivedFinalExam(
          makeClass({ days: DAYS.TuTh, startTime: "10:30:00" })
        )
      ).toBeNull();
      // MWF 2:30 pm is not in the registrar's table (only 2 pm).
      expect(
        getDerivedFinalExam(
          makeClass({ days: DAYS.MWF, startTime: "14:30:00" })
        )
      ).toBeNull();
    });

    it("returns null for TBD meetings (no days or 00:00 start)", () => {
      expect(
        getDerivedFinalExam(
          makeClass({
            days: [false, false, false, false, false, false, false],
          })
        )
      ).toBeNull();
      expect(
        getDerivedFinalExam(makeClass({ startTime: "00:00:00" }))
      ).toBeNull();
    });
  });

  describe("course rules (Fall 2026)", () => {
    it("assigns listed courses regardless of meeting time", () => {
      const cases: [string, string, number][] = [
        ["CHEM", "1A", 3],
        ["ECON", "140", 3],
        ["ECON", "1", 6],
        ["ECON", "100B", 6],
        ["UGBA", "101B", 6],
        ["DATA", "C8", 6],
        ["STAT", "20", 12],
        ["ENGLISH", "R1A", 19],
      ];
      for (const [subject, courseNumber, group] of cases) {
        expect(
          getDerivedFinalExam(
            makeClass({ subject, courseNumber, startTime: "10:00:00" })
          )
        ).toMatchObject({ group });
      }
    });

    it("does not match other courses in the same subject", () => {
      expect(
        getDerivedFinalExam(
          makeClass({
            subject: "CHEM",
            courseNumber: "120A",
            startTime: "10:00:00",
          })
        )
      ).toMatchObject({ group: 1 });
    });
  });

  describe("final exam codes", () => {
    it("returns null for classes without a seated final (N, A, L)", () => {
      for (const finalExam of ["N", "A", "L"]) {
        expect(getDerivedFinalExam(makeClass({ finalExam }))).toBeNull();
      }
    });

    it("returns null for unlisted common finals (C)", () => {
      expect(getDerivedFinalExam(makeClass({ finalExam: "C" }))).toBeNull();
    });

    it("still assigns listed courses with a common final code", () => {
      expect(
        getDerivedFinalExam(
          makeClass({ subject: "CHEM", courseNumber: "1A", finalExam: "C" })
        )
      ).toMatchObject({ group: 3 });
    });

    it("derives for written finals (Y) and unknown codes", () => {
      expect(
        getDerivedFinalExam(makeClass({ finalExam: "Y" }))
      ).toMatchObject({ group: 1 });
      expect(getDerivedFinalExam(makeClass())).toMatchObject({ group: 1 });
    });
  });

  describe("instruction mode", () => {
    it("assigns online and web-based classes to the online group", () => {
      for (const instructionMode of ["O", "W"]) {
        expect(
          getDerivedFinalExam(makeClass({ instructionMode }))
        ).toMatchObject({ group: 10, date: "2026-12-16" });
      }
    });

    it("does not apply the online group to in-person classes", () => {
      expect(
        getDerivedFinalExam(makeClass({ instructionMode: "P" }))
      ).toMatchObject({ group: 1 });
    });
  });

  it("returns null for terms without a calendar", () => {
    expect(
      getDerivedFinalExam(makeClass({ year: 2028, semester: "Spring" }))
    ).toBeNull();
    expect(
      getDerivedFinalExam(makeClass({ year: 2026, semester: "Spring" }))
    ).toBeNull();
  });

  it("derives Spring 2027 exams from the registrar calendar", () => {
    expect(
      getDerivedFinalExam(
        makeClass({
          year: 2027,
          semester: "Spring",
          days: DAYS.MWF,
          startTime: "08:00:00",
        })
      )
    ).toMatchObject({
      group: 1,
      date: "2027-05-10",
      startTime: "08:00",
      source: "derived",
    });
  });
});

describe("getSisFinalExam", () => {
  it("returns the scheduled FIN exam and normalizes YYYYMMDD dates", () => {
    expect(
      getSisFinalExam([
        { type: "MID", date: "2026-10-01", startTime: "18:00:00", endTime: "20:00:00" },
        { type: "FIN", date: "20261214", startTime: "08:00:00", endTime: "11:00:00", location: "Wheeler 150" },
      ])
    ).toEqual({
      date: "2026-12-14",
      startTime: "08:00:00",
      endTime: "11:00:00",
      location: "Wheeler 150",
      source: "sis",
    });
  });

  it("ignores FIN exams without a scheduled date/time", () => {
    expect(
      getSisFinalExam([{ type: "FIN", date: null, startTime: null, endTime: null }])
    ).toBeNull();
    expect(getSisFinalExam([])).toBeNull();
    expect(getSisFinalExam(null)).toBeNull();
  });
});

describe("getClassFinalExam", () => {
  it("prefers the SIS-published exam over the derived one", () => {
    const _class = makeClass();
    _class.primarySection!.exams = [
      {
        type: "FIN",
        date: "2026-12-18",
        startTime: "19:00:00",
        endTime: "22:00:00",
      },
    ];
    expect(getClassFinalExam(_class)).toMatchObject({
      date: "2026-12-18",
      source: "sis",
    });
  });

  it("falls back to the derived exam", () => {
    expect(getClassFinalExam(makeClass())).toMatchObject({
      group: 1,
      source: "derived",
    });
  });
});

describe("finalExamsOverlap", () => {
  const exam = (date: string, startTime: string, endTime: string) => ({
    date,
    startTime,
    endTime,
    source: "derived" as const,
  });

  it("detects same-slot and partial overlaps", () => {
    expect(
      finalExamsOverlap(
        exam("2026-12-14", "08:00", "11:00"),
        exam("2026-12-14", "08:00:00", "11:00:00")
      )
    ).toBe(true);
    expect(
      finalExamsOverlap(
        exam("2026-12-14", "08:00", "11:00"),
        exam("2026-12-14", "10:00", "13:00")
      )
    ).toBe(true);
  });

  it("does not flag different days or back-to-back sittings", () => {
    expect(
      finalExamsOverlap(
        exam("2026-12-14", "08:00", "11:00"),
        exam("2026-12-15", "08:00", "11:00")
      )
    ).toBe(false);
    expect(
      finalExamsOverlap(
        exam("2026-12-14", "08:00", "11:00"),
        exam("2026-12-14", "11:30", "14:30")
      )
    ).toBe(false);
  });
});

describe("formatting", () => {
  it("formats dates without timezone shifts", () => {
    expect(formatFinalExamDate("2026-12-14")).toBe("Mon 12/14");
    expect(formatFinalExamDate("2026-12-18")).toBe("Fri 12/18");
    expect(formatFinalExamDate("2026-12-18", { includeWeekday: false })).toBe(
      "12/18"
    );
    expect(formatFinalExamDate("bogus")).toBeNull();
  });

  it("formats time ranges", () => {
    expect(formatFinalExamTime("08:00", "11:00")).toBe("8–11 AM");
    expect(formatFinalExamTime("11:30:00", "14:30:00")).toBe(
      "11:30 AM–2:30 PM"
    );
    expect(formatFinalExamTime("19:00", "22:00")).toBe("7–10 PM");
  });
});
