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

function nameTokens(value: string): string[] {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .sort();
}

type TokenRow<T> = {
  key: string;
  match: T;
  tokens: string[];
};

const tokenRowsByName = new WeakMap<object, TokenRow<unknown>[]>();

function tokenRowsFor<T>(byName: Map<string, T>): TokenRow<T>[] {
  const cached = tokenRowsByName.get(byName);
  if (cached) return cached as TokenRow<T>[];

  const rows: TokenRow<T>[] = [];
  for (const [key, match] of byName) {
    const sep = key.indexOf("|");
    const family = sep === -1 ? key : key.slice(0, sep);
    const given = sep === -1 ? "" : key.slice(sep + 1);
    const tokens = nameTokens(`${family} ${given}`);
    if (tokens.length === 0) continue;
    rows.push({ key, match, tokens });
  }
  tokenRowsByName.set(byName, rows);
  return rows;
}

function sameTokenList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const aLen = a.length;
  const bLen = b.length;
  if (Math.abs(aLen - bLen) > 1) return false;

  if (aLen === bLen) {
    let first = -1;
    for (let i = 0; i < aLen; i++) {
      if (a[i] === b[i]) continue;
      if (first === -1) {
        first = i;
        continue;
      }
      return (
        i === first + 1 &&
        a[first] === b[i] &&
        a[i] === b[first] &&
        a.slice(i + 1) === b.slice(i + 1)
      );
    }
    return first !== -1;
  }

  const [shorter, longer] = aLen < bLen ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      skipped++;
      j++;
      if (skipped > 1) return false;
    }
  }
  return true;
}

/** Sorted token lists differ by exactly one extra token on one side. */
function oneTokenApart(a: string[], b: string[]): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 2 || longer.length !== shorter.length + 1) return false;

  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      skipped++;
      j++;
      if (skipped > 1) return false;
    }
  }
  return i === shorter.length && skipped + (longer.length - j) === 1;
}

/**
 * One word is a typo of a word at least four letters long, and the longer
 * name has one additional word. Short words stay out so "Hu Li" does not
 * attach to "Li Hua Zhang".
 */
function typoPlusExtraToken(a: string[], b: string[]): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 2 || longer.length !== shorter.length + 1) return false;

  for (let drop = 0; drop < longer.length; drop++) {
    const rest = longer.filter((_, index) => index !== drop);
    let edits = 0;
    let ok = true;
    for (let i = 0; i < shorter.length; i++) {
      if (rest[i] === shorter[i]) continue;
      const minLen = Math.min(rest[i].length, shorter[i].length);
      if (edits === 0 && minLen >= 4 && isOneEditApart(rest[i], shorter[i])) {
        edits++;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && edits === 1) return true;
  }
  return false;
}

/** Extras on `longer` when every `shorter` token is present, or null. */
function extraTokenCount(shorter: string[], longer: string[]): number | null {
  if (longer.length <= shorter.length) return null;
  let i = 0;
  let extras = 0;
  for (let j = 0; j < longer.length; j++) {
    if (i < shorter.length && shorter[i] === longer[j]) i++;
    else extras++;
  }
  return i === shorter.length ? extras : null;
}

function twoTokensApart(a: string[], b: string[]): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 2) return false;
  return extraTokenCount(shorter, longer) === 2;
}

function uniqueTokenMatch<T>(rows: TokenRow<T>[]): T | null {
  if (rows.length === 0) return null;
  const key = rows[0].key;
  for (const row of rows) {
    if (row.key !== key) return null;
  }
  return rows[0].match;
}

/**
 * Same words in a different given/family split, or those words plus one
 * middle name, nickname, or extra surname on only one side. Still-unmatched
 * names can match with one long-word typo plus one extra word, or with
 * exactly two extra words when every other word is identical.
 */
function findTokenNameMatch<T>(
  given: string,
  family: string,
  byName: Map<string, T>
): T | null {
  const tokens = nameTokens(`${family} ${given}`);
  if (tokens.length < 2) return null;

  const rows = tokenRowsFor(byName);
  const stages = [
    (row: TokenRow<T>) => sameTokenList(row.tokens, tokens),
    (row: TokenRow<T>) => oneTokenApart(row.tokens, tokens),
    (row: TokenRow<T>) => typoPlusExtraToken(row.tokens, tokens),
    (row: TokenRow<T>) => twoTokensApart(row.tokens, tokens),
  ];
  for (const stage of stages) {
    const hits = rows.filter(stage);
    if (hits.length > 0) return uniqueTokenMatch(hits);
  }
  return null;
}

/**
 * Exact normalized name, then a single name that is one typo away
 * (insert, delete, substitute, or adjacent swap) on either the given or
 * family name. If several names are one typo away, this does not match.
 * Otherwise a last name that belongs to only one cached person still matches.
 * Names that still miss can match when the same words are split differently
 * across given and family name, when one side has one or two extra words, or
 * when one long word is a typo and the other side has one extra word.
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

  if (!given) return null;
  return findTokenNameMatch(given, family, byName);
}

/** Public Rate My Professor profile URL for a matched instructor. */
export function buildRmpProfessorUrl(legacyId: number): string {
  return `https://www.ratemyprofessors.com/professor/${legacyId}`;
}
