/**
 * Refresh src/lib/finalExam/calendars.json from the registrar's exam page.
 * Existing terms are kept, so a later sheet (e.g. Spring 2028) is added
 * without dropping Spring 2027. Re-running with an unchanged sheet is a no-op.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REGISTRAR_FINAL_EXAM_URL,
  parseRegistrarCalendarCsv,
} from "../src/lib/finalExam/parseRegistrarSheet.ts";

const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/lib/finalExam/calendars.json"
);

const sheetCsvUrl = (iframeSrc: string) => {
  const url = new URL(iframeSrc);
  const gid = url.searchParams.get("gid") ?? "0";
  const pathname = url.pathname.replace(/\/pubhtml$/, "/pub");
  return `${url.origin}${pathname}?gid=${gid}&single=true&output=csv`;
};

const fetchText = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
};

const main = async () => {
  const page = await fetchText(REGISTRAR_FINAL_EXAM_URL);
  const iframes = [
    ...page.matchAll(/<iframe\b[^>]*\bsrc="([^"]+)"[^>]*>/gi),
  ]
    .map((match) => match[1].replaceAll("&amp;", "&"))
    .filter((src) => src.includes("docs.google.com/spreadsheets"));

  if (iframes.length === 0) {
    throw new Error("No final exam spreadsheets found on the registrar page");
  }

  let previous = "";
  let existing: Record<string, unknown> = {};
  try {
    previous = readFileSync(outputPath, "utf8");
    existing = JSON.parse(previous) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = { ...existing };

  for (const iframeSrc of iframes) {
    const csv = await fetchText(sheetCsvUrl(iframeSrc));
    const parsed = parseRegistrarCalendarCsv(csv);
    next[parsed.key] = parsed.calendar;
    console.log(`Loaded ${parsed.key} (${parsed.calendar.slots.length} groups)`);
  }

  const serialized = `${JSON.stringify(
    Object.fromEntries(
      Object.entries(next).sort(([left], [right]) => {
        const [leftYear, leftSemester] = left.split(" ");
        const [rightYear, rightSemester] = right.split(" ");
        if (leftYear !== rightYear) return Number(leftYear) - Number(rightYear);
        if (leftSemester === rightSemester) return 0;
        return leftSemester === "Spring" ? -1 : 1;
      })
    ),
    null,
    2
  )}\n`;
  if (serialized === previous) {
    console.log("Final exam calendars are already up to date.");
    return;
  }
  writeFileSync(outputPath, serialized);
  console.log(`Updated ${outputPath}`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `Could not refresh final exam calendars (${message}). Using the last saved calendar.`
  );
});
