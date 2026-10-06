import { describe, expect, it } from "vitest";

import { listEnrollmentSectionCandidates } from "./enrollmentUrl";

const section = (
  year: number,
  semester: string,
  number: string,
  hasLatest: boolean,
  sessionId?: string
) => ({
  year,
  semester,
  sessionId,
  number,
  primarySection: {
    number,
    enrollment: hasLatest ? { latest: { enrolledCount: 10 } } : null,
  },
});

describe("listEnrollmentSectionCandidates", () => {
  it("returns the first section of the most recent semester with enrollment", () => {
    const classes = [
      section(2024, "Fall", "002", true),
      section(2025, "Spring", "010", true),
      section(2025, "Fall", "003", true),
      section(2025, "Fall", "001", true),
      section(2026, "Spring", "001", false),
    ];

    const candidates = listEnrollmentSectionCandidates(classes);

    expect(candidates.map((courseClass) => courseClass.number)).toEqual([
      "001",
      "003",
      "010",
      "002",
    ]);
    expect(candidates[0]).toMatchObject({
      year: 2025,
      semester: "Fall",
      number: "001",
    });
  });
});
