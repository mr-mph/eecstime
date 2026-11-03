/** Neutral score used for RMP ranking when an instructor has no rating. */
export const RMP_MISSING_RATING_FOR_SORT = 3;

export function normalizeInstructorName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function instructorLookupKey(
  givenName: string,
  familyName: string
): string {
  return `${normalizeInstructorName(familyName)}|${normalizeInstructorName(givenName)}`;
}

/** Characters that can appear in a normalized instructor name. */
const NAME_EDIT_CHARS = "abcdefghijklmnopqrstuvwxyz -";

function rememberOneEditMatch<T>(
  key: string,
  byName: Map<string, T>,
  found: Map<string, T>
): boolean {
  if (found.has(key)) return found.size > 1;
  const value = byName.get(key);
  if (value !== undefined) found.set(key, value);
  return found.size > 1;
}

/**
 * Probe insert, delete, substitute, and adjacent-swap variants of `value`.
 * Returns true once more than one indexed name has matched.
 */
function probeOneEdit<T>(
  value: string,
  toKey: (variant: string) => string,
  byName: Map<string, T>,
  found: Map<string, T>
): boolean {
  const n = value.length;

  for (let i = 0; i < n; i++) {
    if (
      rememberOneEditMatch(
        toKey(value.slice(0, i) + value.slice(i + 1)),
        byName,
        found
      )
    ) {
      return true;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (value[i] === value[i + 1]) continue;
    if (
      rememberOneEditMatch(
        toKey(value.slice(0, i) + value[i + 1] + value[i] + value.slice(i + 2)),
        byName,
        found
      )
    ) {
      return true;
    }
  }

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < NAME_EDIT_CHARS.length; c++) {
      const ch = NAME_EDIT_CHARS[c];
      if (ch === value[i]) continue;
      if (
        rememberOneEditMatch(
          toKey(value.slice(0, i) + ch + value.slice(i + 1)),
          byName,
          found
        )
      ) {
        return true;
      }
    }
  }

  for (let i = 0; i <= n; i++) {
    for (let c = 0; c < NAME_EDIT_CHARS.length; c++) {
      const ch = NAME_EDIT_CHARS[c];
      if (
        rememberOneEditMatch(
          toKey(value.slice(0, i) + ch + value.slice(i)),
          byName,
          found
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

type OneEditResult<T> =
  | { status: "none" }
  | { status: "unique"; match: T }
  | { status: "ambiguous" };

function findOneEditMatch<T>(
  family: string,
  given: string,
  byName: Map<string, T>
): OneEditResult<T> {
  const found = new Map<string, T>();
  const ambiguous =
    probeOneEdit(family, (variant) => `${variant}|${given}`, byName, found) ||
    probeOneEdit(given, (variant) => `${family}|${variant}`, byName, found);
  if (ambiguous || found.size > 1) return { status: "ambiguous" };
  const next = found.values().next();
  if (next.done) return { status: "none" };
  return { status: "unique", match: next.value };
}

/**
 * Exact normalized name, then a single name that is one typo away
 * (insert, delete, substitute, or adjacent swap) on either the given or
 * family name. If several names are one typo away, this does not match.
 * Otherwise a last name that belongs to only one cached person still matches.
 */
export function resolveInstructorMatch<T>(
  givenName: string,
  familyName: string,
  byName: Map<string, T>,
  byLastName: Map<string, T[]>
): T | null {
  const given = normalizeInstructorName(givenName);
  const family = normalizeInstructorName(familyName);
  if (!family) return null;

  if (given) {
    const exact = byName.get(`${family}|${given}`);
    if (exact !== undefined) return exact;

    const fuzzy = findOneEditMatch(family, given, byName);
    if (fuzzy.status === "unique") return fuzzy.match;
    if (fuzzy.status === "ambiguous") return null;
  }

  const lastOnly = byLastName.get(family);
  if (lastOnly?.length === 1) return lastOnly[0];

  return null;
}

/** Public Rate My Professor profile URL for a matched instructor. */
export function buildRmpProfessorUrl(legacyId: number): string {
  return `https://www.ratemyprofessors.com/professor/${legacyId}`;
}
