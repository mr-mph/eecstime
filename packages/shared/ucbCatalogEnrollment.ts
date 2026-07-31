export type ParsedUcbEnrollment = {
  sectionId: string;
  sectionNumber?: string;
  status?: string;
  enrolledCount: number;
  reservedCount: number;
  waitlistedCount: number;
  minEnroll?: number;
  maxEnroll: number;
  maxWaitlist: number;
  openReserved: number;
  instructorAddConsentRequired?: boolean;
  instructorDropConsentRequired?: boolean;
  seatReservationCount: Array<{
    number: number;
    maxEnroll: number;
    enrolledCount?: number;
  }>;
  seatReservationTypes: Array<{
    number: number;
    requirementGroup?: {
      code?: string;
      description: string;
    };
    fromDate: string;
  }>;
};

export type ParsedUcbCatalogEnrollment = {
  primary: ParsedUcbEnrollment;
  associatedSections: ParsedUcbEnrollment[];
};

/** True when the catalog page has no usable seat counts (common on non-controlling cross-listings). */
export function isBlankUcbEnrollment(
  scraped:
    | {
        enrolledCount?: number | null;
        maxEnroll?: number | null;
      }
    | null
    | undefined
): boolean {
  if (!scraped) return true;
  return (scraped.maxEnroll ?? 0) <= 0 && (scraped.enrolledCount ?? 0) <= 0;
}

export type UcbCatalogEnrollmentErrorCode =
  | "BAD_USER_INPUT"
  | "INTERNAL_SERVER_ERROR";

export class UcbCatalogEnrollmentError extends Error {
  readonly code: UcbCatalogEnrollmentErrorCode;

  constructor(message: string, code: UcbCatalogEnrollmentErrorCode) {
    super(message);
    this.name = "UcbCatalogEnrollmentError";
    this.code = code;
  }
}

type UcbEnrollmentStatus = {
  status?: { code?: string; description?: string };
  enrolledCount?: number;
  reservedCount?: number;
  waitlistedCount?: number;
  minEnroll?: number;
  maxEnroll?: number;
  maxWaitlist?: number;
  openReserved?: number;
  instructorAddConsentRequired?: boolean;
  instructorDropConsentRequired?: boolean;
  seatReservations?: Array<{
    number?: number;
    requirementGroup?: { code?: string; description?: string };
    fromDate?: string;
    maxEnroll?: number;
    enrolledCount?: number;
  }>;
};

type UcbEnrollmentPayload = {
  id?: number | string;
  enrollmentStatus?: UcbEnrollmentStatus;
};

const DEFAULT_USER_AGENT = "BerkeleytimeEnrollmentRefresh/1.0";
const DEFAULT_TIMEOUT_MS = 15000;

export function buildUcbCatalogUrl(args: {
  year: number;
  semester: string;
  subject: string;
  courseNumber: string;
  number: string;
  component: string;
}): string {
  const { year, semester, subject, courseNumber, number, component } = args;
  return `https://classes.berkeley.edu/content/${year}-${semester.toLowerCase()}-${subject.toLowerCase()}-${courseNumber}-${number}-${component.toLowerCase()}-${number}`;
}

function extractNodeId(html: string): string | null {
  const match = html.match(/<article[^>]*data-history-node-id="([^"]+)"/i);
  return match?.[1] ?? null;
}

function extractDrupalSettingsJson(html: string): unknown {
  const match = html.match(
    /<script[^>]*data-drupal-selector="drupal-settings-json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) {
    throw new UcbCatalogEnrollmentError(
      "Could not find enrollment data on the Berkeley Catalog page",
      "BAD_USER_INPUT"
    );
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    throw new UcbCatalogEnrollmentError(
      "Could not parse enrollment data from the Berkeley Catalog page",
      "INTERNAL_SERVER_ERROR"
    );
  }
}

type RawSeatReservation = NonNullable<
  UcbEnrollmentStatus["seatReservations"]
>[number];

const reservationFromDateMs = (reservation: RawSeatReservation): number => {
  const raw = reservation.fromDate ?? "";
  const parsed = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Berkeley exposes current reservations under `available` and time-windowed
 * reservations under `history`. After a pool is released, it disappears from
 * `available` but remains in `history` (often with a maxEnroll<=1 stub on the
 * newest window). Prefer `available` when present; otherwise keep the latest
 * real (maxEnroll > 1) history window so we don't wipe reserved-seat rows.
 * Released pools are preserved as full (enrolledCount = maxEnroll).
 */
export function resolveSeatReservationsFromPayloads(
  availableReservations: RawSeatReservation[] | undefined,
  historyReservations: RawSeatReservation[] | undefined
): {
  seatReservationCount: ParsedUcbEnrollment["seatReservationCount"];
  seatReservationTypes: ParsedUcbEnrollment["seatReservationTypes"];
} {
  const available = availableReservations ?? [];
  const history = historyReservations ?? [];
  const availableNumbers = new Set(
    available
      .map((reservation) => reservation.number)
      .filter((number): number is number => number != null)
  );

  const historyByNumber = new Map<number, RawSeatReservation[]>();
  for (const reservation of history) {
    if (reservation.number == null) continue;
    const list = historyByNumber.get(reservation.number) ?? [];
    list.push(reservation);
    historyByNumber.set(reservation.number, list);
  }

  const selected = new Map<number, RawSeatReservation>();

  for (const reservation of available) {
    if (reservation.number == null) continue;
    selected.set(reservation.number, reservation);
  }

  for (const [number, windows] of historyByNumber) {
    if (availableNumbers.has(number)) continue;
    const sorted = [...windows].sort(
      (a, b) => reservationFromDateMs(a) - reservationFromDateMs(b)
    );
    const latest = sorted[sorted.length - 1];
    const latestActive = [...sorted]
      .reverse()
      .find((reservation) => (reservation.maxEnroll ?? 0) > 1);

    if (!latestActive) continue;

    // Newest window is a release stub — keep the group, mark it full.
    if ((latest?.maxEnroll ?? 0) <= 1) {
      selected.set(number, {
        ...latestActive,
        enrolledCount: latestActive.maxEnroll ?? 0,
      });
      continue;
    }

    selected.set(number, latestActive);
  }

  // Labels come from the selected windows so release stubs with future
  // fromDates don't mark preserved groups as inactive.
  const typesByNumber = new Map<
    number,
    ParsedUcbEnrollment["seatReservationTypes"][number]
  >();
  const considerType = (reservation: RawSeatReservation) => {
    if (
      reservation.number == null ||
      !reservation.requirementGroup?.description ||
      typesByNumber.has(reservation.number)
    ) {
      return;
    }
    typesByNumber.set(reservation.number, {
      number: reservation.number,
      requirementGroup: {
        code: reservation.requirementGroup.code,
        description: reservation.requirementGroup.description ?? "Unknown",
      },
      fromDate: reservation.fromDate ?? "",
    });
  };
  for (const reservation of selected.values()) considerType(reservation);
  for (const reservation of available) considerType(reservation);
  for (const reservation of history) considerType(reservation);

  const seatReservationCount = [...selected.values()].map((reservation) => ({
    number: reservation.number ?? 0,
    maxEnroll: reservation.maxEnroll ?? 0,
    enrolledCount: reservation.enrolledCount,
  }));

  return {
    seatReservationCount,
    seatReservationTypes: [...typesByNumber.values()],
  };
}

/** Union seat-reservation labels by number; incoming overwrites same number. */
export function mergeSeatReservationTypes<
  T extends ParsedUcbEnrollment["seatReservationTypes"][number],
>(existing: T[] | undefined, incoming: T[] | undefined): T[] {
  const byNumber = new Map<number, T>();
  for (const type of existing ?? []) {
    if (type.number == null) continue;
    byNumber.set(type.number, type);
  }
  for (const type of incoming ?? []) {
    if (type.number == null) continue;
    byNumber.set(type.number, type);
  }
  return [...byNumber.values()];
}

export function seatReservationCountsEqual(
  a:
    | Array<{ number?: number; maxEnroll?: number; enrolledCount?: number }>
    | undefined,
  b:
    | Array<{ number?: number; maxEnroll?: number; enrolledCount?: number }>
    | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (const item of left) {
    const match = right.find((other) => other.number === item.number);
    if (!match) return false;
    if (
      (item.maxEnroll ?? 0) !== (match.maxEnroll ?? 0) ||
      (item.enrolledCount ?? 0) !== (match.enrolledCount ?? 0)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * If an update drops a reserved group, keep it with 0 seats left.
 * Incoming values win for shared numbers.
 */
export function preserveRemovedSeatReservationCounts<
  T extends { number?: number; maxEnroll?: number; enrolledCount?: number },
>(incoming: T[] | undefined, previous: T[] | undefined): T[] {
  const byNumber = new Map<number, T>();
  for (const reservation of previous ?? []) {
    if (reservation.number == null) continue;
    if ((reservation.maxEnroll ?? 0) <= 1) continue;
    byNumber.set(reservation.number, {
      ...reservation,
      enrolledCount: reservation.maxEnroll,
    });
  }
  for (const reservation of incoming ?? []) {
    if (reservation.number == null) continue;
    byNumber.set(reservation.number, reservation);
  }
  return [...byNumber.values()];
}

function mapEnrollmentStatus(
  payload: UcbEnrollmentPayload | undefined,
  seatReservationsOverride?: {
    seatReservationCount: ParsedUcbEnrollment["seatReservationCount"];
    seatReservationTypes: ParsedUcbEnrollment["seatReservationTypes"];
  }
): ParsedUcbEnrollment | null {
  const status = payload?.enrollmentStatus;
  if (!status || payload?.id == null) return null;

  const seatReservations = status.seatReservations ?? [];
  const resolved =
    seatReservationsOverride ??
    resolveSeatReservationsFromPayloads(seatReservations, undefined);

  return {
    sectionId: String(payload.id),
    status: status.status?.code,
    enrolledCount: status.enrolledCount ?? 0,
    reservedCount: status.reservedCount ?? 0,
    waitlistedCount: status.waitlistedCount ?? 0,
    minEnroll: status.minEnroll,
    maxEnroll: status.maxEnroll ?? 0,
    maxWaitlist: status.maxWaitlist ?? 0,
    openReserved: status.openReserved ?? 0,
    instructorAddConsentRequired: status.instructorAddConsentRequired,
    instructorDropConsentRequired: status.instructorDropConsentRequired,
    seatReservationCount: resolved.seatReservationCount,
    seatReservationTypes: resolved.seatReservationTypes,
  };
}

export function parseUcbCatalogEnrollment(html: string): ParsedUcbEnrollment {
  const settings = extractDrupalSettingsJson(html) as {
    ucb?: {
      enrollment?: {
        available?: UcbEnrollmentPayload;
        history?: UcbEnrollmentPayload;
      };
    };
  };

  const availablePayload = settings.ucb?.enrollment?.available;
  const historyPayload = settings.ucb?.enrollment?.history;
  const resolvedSeats = resolveSeatReservationsFromPayloads(
    availablePayload?.enrollmentStatus?.seatReservations,
    historyPayload?.enrollmentStatus?.seatReservations
  );

  const parsed =
    mapEnrollmentStatus(availablePayload, resolvedSeats) ??
    mapEnrollmentStatus(historyPayload, resolvedSeats);

  if (!parsed) {
    throw new UcbCatalogEnrollmentError(
      "Berkeley Catalog page did not include enrollment counts",
      "BAD_USER_INPUT"
    );
  }

  return parsed;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumberField(text: string, label: string): number | undefined {
  const match = text.match(new RegExp(`${label}:\\s*([0-9]+)`, "i"));
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}

export function parseAssociatedSectionEnrollments(
  html: string
): ParsedUcbEnrollment[] {
  const chunks = html.match(
    /<div class="detail-class-associated-sections-flex">[\s\S]*?(?=<div class="detail-class-associated-sections-flex">|$)/g
  );
  if (!chunks) return [];

  return chunks
    .map((chunk) => {
      const text = stripTags(chunk);
      const sectionMatch = text.match(/\b([0-9]{3}[A-Z]?)\s+[A-Z]+\b/i);
      const classNumberMatch = text.match(/Class #:\s*([0-9]+)/i);
      const enrolledCount = parseNumberField(text, "Enrolled");
      const maxEnroll = parseNumberField(text, "Enrollment Limit");
      const waitlistedCount = parseNumberField(text, "Waitlisted") ?? 0;
      const maxWaitlist = parseNumberField(text, "Waitlist limit") ?? 0;

      if (
        !sectionMatch?.[1] ||
        !classNumberMatch?.[1] ||
        enrolledCount == null ||
        maxEnroll == null
      ) {
        return null;
      }

      const parsed: ParsedUcbEnrollment = {
        sectionId: classNumberMatch[1],
        sectionNumber: sectionMatch[1],
        status: enrolledCount < maxEnroll ? "O" : "C",
        enrolledCount,
        reservedCount: enrolledCount,
        waitlistedCount,
        maxEnroll,
        maxWaitlist,
        openReserved: Math.max(0, maxEnroll - enrolledCount),
        seatReservationCount: [],
        seatReservationTypes: [],
      };

      return parsed;
    })
    .filter((section): section is ParsedUcbEnrollment => section != null);
}

export type FetchUcbCatalogEnrollmentOptions = {
  userAgent?: string;
  timeoutMs?: number;
  /** Override fetch (e.g. backend rate-limited queue). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
};

export async function fetchUcbCatalogEnrollment(
  url: string,
  options: FetchUcbCatalogEnrollmentOptions = {}
): Promise<ParsedUcbCatalogEnrollment> {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  const readText = async (response: Response): Promise<string> => {
    // Headers can succeed while the body stalls; bound the full read.
    return await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject(
            new UcbCatalogEnrollmentError(
              `Timed out reading Berkeley Catalog body after ${timeoutMs}ms`,
              "INTERNAL_SERVER_ERROR"
            )
          );
        }, timeoutMs);
      }),
    ]);
  };

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UcbCatalogEnrollmentError(
      `Failed to reach Berkeley Catalog: ${
        error instanceof Error ? error.message : "network error"
      }`,
      "INTERNAL_SERVER_ERROR"
    );
  }

  if (!response.ok) {
    throw new UcbCatalogEnrollmentError(
      `Berkeley Catalog returned HTTP ${response.status}`,
      "BAD_USER_INPUT"
    );
  }

  const html = await readText(response);
  const primary = parseUcbCatalogEnrollment(html);

  const nodeId = extractNodeId(html);
  if (!nodeId) {
    return { primary, associatedSections: [] };
  }

  const associatedUrl = new URL(`/sections/associated/${nodeId}`, url);
  let associatedSections: ParsedUcbEnrollment[] = [];
  try {
    const associatedResponse = await doFetch(associatedUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (associatedResponse.ok) {
      associatedSections = parseAssociatedSectionEnrollments(
        await readText(associatedResponse)
      );
    }
  } catch {
    // Associated sections are best-effort; keep primary refresh working.
  }

  return { primary, associatedSections };
}
