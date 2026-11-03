import {
  ENROLLMENT_USER_AGENT,
  type ParsedUcbCatalogEnrollment,
  type ParsedUcbEnrollment,
  isBlankUcbEnrollment,
} from "./ucbCatalogEnrollment";

export const BERKELEYTIME_GRAPHQL_URL = "https://berkeleytime.com/api/graphql";
export const ENROLLMENT_FETCH_USER_AGENT = ENROLLMENT_USER_AGENT;
/**
 * berkeleytime.com's numbers come from classes.berkeley.edu, whose CDN can
 * serve a page for up to 15 minutes. Stamp an imported point this far before
 * the time berkeleytime recorded so it cannot look newer than a direct scrape.
 */
export const BERKELEYTIME_NUMBER_DELAY_MS = 15 * 60 * 1000;

/**
 * Allowlisted id for the catalog class document on berkeleytime.com.
 * Production rejects a raw `query` body. The id is the SHA-256 of that
 * document after GraphQL print and stripIgnoredCharacters, which is how the
 * site's client addresses persisted operations. The document includes the
 * primary section and associated sections, each with latest enrollment.
 */
const GET_CLASS_OPERATION_ID =
  "79775dae18f1f702ad5c0d177254b33b973f126c5e21750cb7b5569ec5146a87";

export type BerkeleytimeClassKey = {
  year: number;
  semester: string;
  sessionId: string;
  subject: string;
  courseNumber: string;
  number: string;
};

type LatestEnrollment = {
  startTime?: string | null;
  endTime?: string | null;
  status?: string | null;
  enrolledCount?: number | null;
  maxEnroll?: number | null;
  waitlistedCount?: number | null;
  maxWaitlist?: number | null;
  seatReservationCount?: Array<{
    enrolledCount?: number | null;
    maxEnroll?: number | null;
    requirementGroup?: { description?: string | null } | null;
    isValid?: boolean | null;
  } | null> | null;
};

type ClassSection = {
  sectionId?: string | null;
  number?: string | null;
  enrollment?: { latest?: LatestEnrollment | null } | null;
};

export function berkeleytimeClassUrl(key: BerkeleytimeClassKey): string {
  return `https://berkeleytime.com/catalog/${key.year}/${key.semester}/${key.subject}/${key.courseNumber}/${key.number}/${key.sessionId}`;
}

function mapSection(
  section: ClassSection | null | undefined
): ParsedUcbEnrollment | null {
  const latest = section?.enrollment?.latest;
  if (!section?.sectionId || !latest) return null;
  const enrolledCount = latest.enrolledCount ?? 0;
  const maxEnroll = latest.maxEnroll ?? 0;
  if (maxEnroll <= 0 && enrolledCount <= 0) return null;

  const seats = (latest.seatReservationCount ?? []).flatMap((seat, index) => {
    if (!seat || seat.isValid === false) return [];
    return [
      {
        number: index + 1,
        maxEnroll: seat.maxEnroll ?? 0,
        enrolledCount: seat.enrolledCount ?? 0,
        description: seat.requirementGroup?.description || "Reserved",
      },
    ];
  });

  return {
    sectionId: String(section.sectionId),
    sectionNumber: section.number ?? undefined,
    status: latest.status ?? (enrolledCount < maxEnroll ? "O" : "C"),
    enrolledCount,
    reservedCount: enrolledCount,
    waitlistedCount: latest.waitlistedCount ?? 0,
    maxEnroll,
    maxWaitlist: latest.maxWaitlist ?? 0,
    openReserved: Math.max(0, maxEnroll - enrolledCount),
    seatReservationCount: seats.map(
      ({ number, maxEnroll: max, enrolledCount: enrolled }) => ({
        number,
        maxEnroll: max,
        enrolledCount: enrolled,
      })
    ),
    seatReservationTypes: seats.map(({ number, description }) => ({
      number,
      requirementGroup: { description },
      fromDate: "",
    })),
  };
}

function observedAt(latest: LatestEnrollment | null | undefined): number {
  const raw = Date.parse(latest?.endTime ?? latest?.startTime ?? "");
  const recorded = Number.isFinite(raw)
    ? Math.min(raw, Date.now())
    : Date.now();
  return recorded - BERKELEYTIME_NUMBER_DELAY_MS;
}

/**
 * Read the class's latest enrollment from berkeleytime.com. Returns null when
 * the class or its counts are missing. Throws when the site does not answer.
 */
export async function fetchBerkeleytimeEnrollment(
  key: BerkeleytimeClassKey,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}
): Promise<ParsedUcbCatalogEnrollment | null> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(BERKELEYTIME_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/graphql-response+json,application/json;q=0.9",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      "User-Agent": ENROLLMENT_FETCH_USER_AGENT,
      Referer: berkeleytimeClassUrl(key),
    },
    body: JSON.stringify({
      id: GET_CLASS_OPERATION_ID,
      variables: {
        year: key.year,
        semester: key.semester,
        sessionId: key.sessionId,
        subject: key.subject,
        courseNumber: key.courseNumber,
        number: key.number,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ");
    const challenge =
      /just a moment|cf-browser-verification|challenge-platform/i.test(body);
    const detail = challenge ? "Cloudflare browser check" : body.slice(0, 160);
    throw new Error(
      `berkeleytime.com returned HTTP ${response.status}${
        detail ? `: ${detail}` : ""
      }`
    );
  }

  const payload = (await response.json()) as {
    errors?: Array<{ message?: string }>;
    data?: {
      class?: {
        primarySection?: ClassSection | null;
        sections?: ClassSection[] | null;
      } | null;
    } | null;
  };
  if (!payload.data?.class) {
    const message = payload.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    if (message) throw new Error(`berkeleytime.com: ${message}`);
    return null;
  }
  const primary = mapSection(payload.data.class.primarySection);
  if (!primary || isBlankUcbEnrollment(primary)) return null;

  const primaryId = primary.sectionId;
  const associatedSections = (payload.data?.class?.sections ?? [])
    .map((section) => mapSection(section))
    .filter(
      (section): section is ParsedUcbEnrollment =>
        section != null && section.sectionId !== primaryId
    );

  return {
    primary,
    associatedSections,
    pageGeneratedAt: observedAt(
      payload.data?.class?.primarySection?.enrollment?.latest
    ),
  };
}
