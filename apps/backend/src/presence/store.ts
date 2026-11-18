/**
 * Rough visitor analytics, kept in a small JSON file (not Mongo) and
 * summarized in the backend logs. Nothing is shown in the UI.
 *
 * File (ANALYTICS_FILE, default apps/backend/data/analytics.json):
 *   {
 *     "version": 3,
 *     "timezone": "America/Los_Angeles",
 *     "salt": "...",                                   // never changes
 *     "visitors": { "<id>": { "firstSeen": <ms>, "lastSeen": <ms> } },
 *     "aliases": { "<key>": "<id>" },                  // identities -> visitor
 *     "days": { "2026-11-09": ["<id>", ...] },         // who visited each PT day
 *     "hours": { "2026-11-09T21": ["<id>", ...] }      // same per PT hour (31 days)
 *   }
 *
 * Who is a visitor (see identify()): a heartbeat carries a random id the
 * browser keeps in localStorage, the signed-in account (if any) and a
 * FingerprintJS fingerprint. Each maps through `aliases` to one canonical
 * visitor, so a person keeps the same id across days, networks and browser
 * updates, and across devices once they sign in. When two records turn out to
 * be the same person they're merged, so counts only ever shrink toward the
 * truth. Only salted hashes are stored, never raw ids, fingerprints or IPs.
 *
 * Version 2 ids (hash of fingerprint + IP + user agent) are matched on a
 * visitor's first new-style heartbeat, so existing visitors keep their
 * history instead of being counted again.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const TIMEZONE = "America/Los_Angeles";
/** "Online now" = heartbeat within this window (clients ping every minute). */
const ONLINE_WINDOW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WRITE_DEBOUNCE_MS = 10_000;
/** Hourly visitor lists are pruned after this many days; daily ones are kept. */
const KEEP_HOURS_DAYS = 31;

type Visitor = { firstSeen: number; lastSeen: number };
type AnalyticsFile = {
  version: 3;
  timezone: string;
  salt: string;
  visitors: Record<string, Visitor>;
  aliases: Record<string, string>;
  days: Record<string, string[]>;
  hours: Record<string, string[]>;
};

/** What a heartbeat tells us about who's visiting. */
export type VisitorIdentity = {
  /** Random id kept in the browser's localStorage (null if storage is blocked). */
  clientId: string | null;
  /** Signed-in account id, if any. */
  userId: string | null;
  /** FingerprintJS visitor id. */
  fingerprint: string;
  ip: string;
  userAgent: string;
};

export type AnalyticsSummary = {
  thisHour: number;
  onlineNow: number;
  last24h: number;
  today: number;
  last7Days: number;
  last30Days: number;
  allTime: number;
};

const partsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});
const ptParts = (ms: number) =>
  Object.fromEntries(
    partsFormat.formatToParts(new Date(ms)).map((p) => [p.type, p.value])
  ) as Record<"year" | "month" | "day" | "hour", string>;

/** "YYYY-MM-DD" in Pacific time. */
export const dayKey = (ms: number) => {
  const p = ptParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};

/** "YYYY-MM-DDTHH" in Pacific time. */
export const hourKey = (ms: number) => {
  const p = ptParts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
};

/** `count` day keys ending at `lastDay`, oldest first (calendar steps, DST-safe). */
export const dayRange = (lastDay: string, count: number) => {
  const [y, m, d] = lastDay.split("-").map(Number);
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y, m - 1, d - (count - 1 - i))).toISOString().slice(0, 10)
  );
};

export class PresenceStore {
  private data: AnalyticsFile;
  /** Per-day id sets for fast de-duplication (mirrors data.days). */
  private daySets = new Map<string, Set<string>>();
  private hourSets = new Map<string, Set<string>>();
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.data = this.load();
    for (const [day, ids] of Object.entries(this.data.days)) {
      this.daySets.set(day, new Set(ids));
    }
    for (const [hour, ids] of Object.entries(this.data.hours)) {
      this.hourSets.set(hour, new Set(ids));
    }
  }

  private load(): AnalyticsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if ((parsed?.version === 2 || parsed?.version === 3) && parsed.salt) {
        parsed.version = 3;
        parsed.visitors ??= {};
        parsed.aliases ??= {};
        parsed.days ??= {};
        parsed.hours ??= {};
        return parsed as AnalyticsFile;
      }
      if (parsed?.salt) {
        // Older format: keep the salt so ids stay stable; history restarts.
        return this.empty(parsed.salt);
      }
    } catch {
      // Missing or unreadable: start fresh.
    }
    return this.empty(randomBytes(16).toString("hex"));
  }

  private empty(salt: string): AnalyticsFile {
    return {
      version: 3,
      timezone: TIMEZONE,
      salt,
      visitors: {},
      aliases: {},
      days: {},
      hours: {},
    };
  }

  private hash(value: string) {
    return createHash("sha256")
      .update(`${this.data.salt}|${value}`)
      .digest("base64url")
      .slice(0, 22);
  }

  /** Version 2 visitor id: fingerprint + IP + user agent. */
  legacyVisitorId(fingerprint: string, ip: string, userAgent: string) {
    return this.hash(`${fingerprint}|${ip}|${userAgent}`);
  }

  /**
   * Resolve a heartbeat to its canonical visitor id, linking every identity
   * it carries to that visitor:
   *  1. the signed-in account, if already linked to a visitor;
   *  2. the browser's stored id, if already linked;
   *  3. the version 2 id (no count spike when switching schemes);
   *  4. the fingerprint alone, but only when the browser can't store an id
   *     (identical devices can share a fingerprint);
   *  5. otherwise a new visitor.
   * If the account and the browser point at different visitors (e.g. signing
   * in on a second device), the browser's visitor is merged into the
   * account's.
   */
  identify(who: VisitorIdentity): string {
    const keys: string[] = [];
    if (who.userId) keys.push(`u:${this.hash(`user|${who.userId}`)}`);
    if (who.clientId) keys.push(`c:${this.hash(`client|${who.clientId}`)}`);
    else keys.push(`f:${this.hash(`fingerprint|${who.fingerprint}`)}`);

    const known = keys
      .map((key) => this.data.aliases[key])
      .filter((id): id is string => !!id && !!this.data.visitors[id]);
    const legacy = this.legacyVisitorId(who.fingerprint, who.ip, who.userAgent);
    const legacyUnclaimed =
      !!this.data.visitors[legacy] &&
      !Object.values(this.data.aliases).includes(legacy);

    let id = known[0];
    if (!id && this.data.visitors[legacy]) id = legacy;
    if (!id) id = keys[0].slice(2);

    // Same person under another record: fold it in.
    for (const other of new Set(known)) if (other !== id) this.merge(other, id);
    // A version 2 record for this browser that nothing claims yet (seen before
    // the switch) is this visitor too.
    if (legacyUnclaimed && legacy !== id) this.merge(legacy, id);

    for (const key of keys) this.data.aliases[key] = id;
    return id;
  }

  /** Fold visitor `from` into `to` (history, aliases), dropping `from`. */
  private merge(from: string, to: string) {
    const a = this.data.visitors[from];
    const b = this.data.visitors[to];
    if (a) {
      this.data.visitors[to] = {
        firstSeen: Math.min(a.firstSeen, b?.firstSeen ?? a.firstSeen),
        lastSeen: Math.max(a.lastSeen, b?.lastSeen ?? a.lastSeen),
      };
      delete this.data.visitors[from];
    }
    const groups: [Map<string, Set<string>>, Record<string, string[]>][] = [
      [this.daySets, this.data.days],
      [this.hourSets, this.data.hours],
    ];
    for (const [sets, lists] of groups) {
      for (const [key, set] of sets) {
        if (!set.has(from)) continue;
        set.delete(from);
        set.add(to);
        lists[key] = [...set];
      }
    }
    for (const [key, id] of Object.entries(this.data.aliases)) {
      if (id === from) this.data.aliases[key] = to;
    }
    this.scheduleWrite();
  }

  /** Record a heartbeat. */
  touch(id: string, now = Date.now()) {
    const visitor = this.data.visitors[id];
    this.data.visitors[id] = { firstSeen: visitor?.firstSeen ?? now, lastSeen: now };

    this.addTo(this.daySets, this.data.days, dayKey(now), id);
    this.addTo(this.hourSets, this.data.hours, hourKey(now), id);
    this.scheduleWrite();
  }

  private addTo(
    sets: Map<string, Set<string>>,
    lists: Record<string, string[]>,
    key: string,
    id: string
  ) {
    let set = sets.get(key);
    if (!set) {
      set = new Set();
      sets.set(key, set);
      lists[key] = [];
    }
    if (!set.has(id)) {
      set.add(id);
      lists[key].push(id);
    }
  }

  /** Unique visitors across the last `days` PT days (including today). */
  private uniqueOverDays(now: number, days: number) {
    const ids = new Set<string>();
    for (const day of dayRange(dayKey(now), days)) {
      for (const id of this.daySets.get(day) ?? []) ids.add(id);
    }
    return ids.size;
  }

  /** Unique visitors per PT hour for the last `hours` hours, oldest first. */
  hourly(now: number, hours: number) {
    return Array.from({ length: hours }, (_, i) => {
      const hour = hourKey(now - (hours - 1 - i) * HOUR_MS);
      return { hour, visitors: this.hourSets.get(hour)?.size ?? 0 };
    }).filter((h, i, all) => i === 0 || h.hour !== all[i - 1].hour); // DST repeat
  }

  /** Unique visitors per PT day for the last `days` days, oldest first. */
  daily(now: number, days: number) {
    return dayRange(dayKey(now), days).map((day) => ({
      day,
      visitors: this.daySets.get(day)?.size ?? 0,
    }));
  }

  summary(now = Date.now()): AnalyticsSummary {
    let onlineNow = 0;
    let last24h = 0;
    for (const { lastSeen } of Object.values(this.data.visitors)) {
      if (now - lastSeen <= ONLINE_WINDOW_MS) onlineNow += 1;
      if (now - lastSeen <= DAY_MS) last24h += 1;
    }
    return {
      thisHour: this.hourSets.get(hourKey(now))?.size ?? 0,
      onlineNow,
      last24h,
      today: this.daySets.get(dayKey(now))?.size ?? 0,
      last7Days: this.uniqueOverDays(now, 7),
      last30Days: this.uniqueOverDays(now, 30),
      allTime: Object.keys(this.data.visitors).length,
    };
  }

  /** Unique visitors on one PT day. */
  dayCount(day: string) {
    return this.daySets.get(day)?.size ?? 0;
  }

  private scheduleWrite() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  /** Prune old hourly lists and write the file atomically. */
  flush(now = Date.now()) {
    const cutoff = dayRange(dayKey(now), KEEP_HOURS_DAYS)[0];
    for (const hour of Object.keys(this.data.hours)) {
      if (hour.slice(0, 10) < cutoff) {
        delete this.data.hours[hour];
        this.hourSets.delete(hour);
      }
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (error) {
      console.error("[Analytics] Failed to write", this.file, error);
    }
  }
}

export const presenceStore = new PresenceStore(
  process.env.ANALYTICS_FILE || path.resolve(process.cwd(), "data/analytics.json")
);

const formatSummary = (s: AnalyticsSummary) =>
  `this hour ${s.thisHour} · online now ${s.onlineNow} · last 24h ${s.last24h} · today ${s.today} · ` +
  `7 days ${s.last7Days} · 30 days ${s.last30Days} · all time ${s.allTime}`;

/**
 * Log a summary at startup and every hour, plus a line for each finished PT
 * day:  docker compose logs backend | grep '\[Analytics\]'
 */
export const startAnalyticsLogging = () => {
  console.log(`[Analytics] unique visitors: ${formatSummary(presenceStore.summary())}`);
  let lastDay = dayKey(Date.now());
  const timer = setInterval(() => {
    const now = Date.now();
    const day = dayKey(now);
    if (day !== lastDay) {
      console.log(`[Analytics] ${lastDay}: ${presenceStore.dayCount(lastDay)} unique visitors`);
      lastDay = day;
    }
    console.log(`[Analytics] unique visitors: ${formatSummary(presenceStore.summary(now))}`);
  }, HOUR_MS);
  timer.unref();
};

// Don't lose the last few seconds of visits on restart.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    presenceStore.flush();
    process.kill(process.pid, signal);
  });
}
