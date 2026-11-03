import { RmpProfessorModel } from "@repo/common/models";
import {
  buildRmpProfessorUrl,
  instructorLookupKey,
  normalizeInstructorName,
  resolveInstructorMatch,
} from "@repo/shared";

type RmpMatch = {
  avgRating: number;
  legacyId: number;
};

type RmpLookupMaps = {
  byName: Map<string, RmpMatch>;
  byLastName: Map<string, RmpMatch[]>;
  loadedAt: number;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: RmpLookupMaps | null = null;
let loading: Promise<RmpLookupMaps> | null = null;

async function loadRmpLookupMaps(): Promise<RmpLookupMaps> {
  const professors = await RmpProfessorModel.find({
    numRatings: { $gt: 0 },
    avgRating: { $ne: null },
  })
    .select({ firstName: 1, lastName: 1, avgRating: 1, legacyId: 1 })
    .lean();

  const byName = new Map<string, RmpMatch>();
  const byLastName = new Map<string, RmpMatch[]>();

  for (const professor of professors) {
    if (professor.avgRating == null) continue;
    const match: RmpMatch = {
      avgRating: professor.avgRating,
      legacyId: professor.legacyId,
    };
    const key = instructorLookupKey(professor.firstName, professor.lastName);
    if (!byName.has(key)) {
      byName.set(key, match);
    }

    const last = normalizeInstructorName(professor.lastName);
    if (!last) continue;
    const list = byLastName.get(last) ?? [];
    list.push(match);
    byLastName.set(last, list);
  }

  return { byName, byLastName, loadedAt: Date.now() };
}

async function getRmpLookupMaps(): Promise<RmpLookupMaps> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (!loading) {
    loading = loadRmpLookupMaps()
      .then((maps) => {
        cache = maps;
        return maps;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Returns rating + legacyId when matched, otherwise null. */
export async function lookupInstructorRmp(
  givenName?: string | null,
  familyName?: string | null
): Promise<RmpMatch | null> {
  const given = givenName?.trim() ?? "";
  const family = familyName?.trim() ?? "";
  if (!family) return null;

  const { byName, byLastName } = await getRmpLookupMaps();
  return resolveInstructorMatch(given, family, byName, byLastName);
}

/** Returns a real RMP score, or null when the instructor is N/A / unmatched. */
export async function lookupInstructorRmpRating(
  givenName?: string | null,
  familyName?: string | null
): Promise<number | null> {
  const match = await lookupInstructorRmp(givenName, familyName);
  return match?.avgRating ?? null;
}

/** Returns the public RMP profile URL, or null when unmatched. */
export async function lookupInstructorRmpUrl(
  givenName?: string | null,
  familyName?: string | null
): Promise<string | null> {
  const match = await lookupInstructorRmp(givenName, familyName);
  return match ? buildRmpProfessorUrl(match.legacyId) : null;
}
