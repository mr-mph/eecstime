import { createWriteStream } from "node:fs";
import { access, open, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { model, Schema } from "mongoose";

import { Config } from "../shared/config";
import {
  syncCatalogEnrollmentForAllCatalogTerms,
  updateCatalogGradeSummaries,
  updateCatalogRatingsForAllCatalogTerms,
  updateCatalogRmpRatings,
} from "../lib/catalog-denormalize";
import {
  reapplyEecsTimeProtectedData,
  snapshotEecsTimeProtectedData,
} from "../lib/eecsTimeUserBackup";
import { syncDraftSchedules } from "../lib/draft-schedule";
import { syncCrosslistingEnrollmentFanout } from "./crosslisting-enrollment-fanout";
import { rebuildCourseGradeSummaries } from "./grade-distributions";

const PUBLIC_BACKUP_BASE =
  "https://backups.berkeleytime.com/public/daily/prod_public_backup";

/**
 * How many PT calendar days back to probe when looking for the newest public
 * backup. Cron schedules are unreliable (job start ≠ upload ready), so we
 * HEAD recent dates instead of assuming a publish hour.
 */
const BACKUP_LOOKBACK_DAYS = 3;

/**
 * Never touch enrichment datasets we pull ourselves:
 * - rmp_professors: Rate My Professors cache
 * - articulations: ASSIST.org CCC→Berkeley articulations
 *
 * Public dumps include GradTrak (`plans`), ratings, and reviews (keyed by
 * email / createdBy). Users who have logged into EECSTime (`eecsTimeUser`)
 * are snapshotted and re-applied after restore so their local rows win;
 * everyone else gets the Berkeleytime backup copy.
 *
 * `users` / `schedules` / `collections` are not in the public dump today;
 * we still nsExclude them so a future dump cannot clobber EECSTime logins
 * without going through the protection path (snapshot only covers
 * `eecsTimeUser: true` rows).
 *
 * Tentative EECS terms are NOT excluded here (they live in shared
 * classes/sections/terms/catalog_classes). Instead we re-seed them from the
 * stored EECS draft scrape after every successful merge.
 */
const NS_EXCLUDE = [
  // Ops / analytics — keep local
  "bt.banners",
  "bt.bannerviewcounts",
  "bt.classviewcounts",
  "bt.clickevents",
  "bt.semester-roles",
  "bt.staff-members",
  "bt.targetedmessages",
  "bt.aggregatedmetrics",
  // Locally owned enrichment
  "bt.rmp_professors",
  "bt.articulations",
  // Local job bookkeeping
  "bt.enrollment_backup_sync_statuses",
  "bt.draft_schedule_snapshots",
  "bt.ucb_enrollment_scrape_statuses",
  // Auth / schedule identity — not migrated from public dump; protect local
  "bt.users",
  "bt.schedules",
  "bt.collections",
  "bt.pods",
] as const;

/**
 * Always snapshot/restore these after any --drop restore (not user-migrated).
 */
const LOCAL_OWNED_COLLECTIONS = ["rmp_professors", "articulations"] as const;

const SYNC_STATUS_KEY = "public-backup-sync";
const SYNC_LOCK_PATH = "/tmp/enrollment-from-public-backup.lock";

/** mongorestore treats /db in the URI as --db; strip it when using --archive. */
const mongoToolsUri = (uri: string): string =>
  uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*/, "$1/");

interface IPublicBackupSyncStatus {
  key: string;
  lastBackupDate?: string | null;
  lastEtag?: string | null;
  lastRestoredAt?: Date | null;
  message?: string | null;
}

const publicBackupSyncStatusSchema = new Schema<IPublicBackupSyncStatus>(
  {
    key: { type: String, required: true, unique: true },
    lastBackupDate: { type: String, default: null },
    lastEtag: { type: String, default: null },
    lastRestoredAt: { type: Date, default: null },
    message: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

const PublicBackupSyncStatusModel = model<IPublicBackupSyncStatus>(
  "enrollment_backup_sync_status",
  publicBackupSyncStatusSchema
);

/** YYYYMMDD calendar date in America/Los_Angeles for an absolute instant. */
const ptDateKey = (instant: Date): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}${month}${day}`;
};

/**
 * PT calendar days ending at "today" (most recent first). Uses noon UTC offsets
 * so DST transitions don't skip/duplicate a calendar day.
 */
const recentPtDateKeys = (
  lookbackDays = BACKUP_LOOKBACK_DAYS,
  now = new Date()
): string[] => {
  const todayKey = ptDateKey(now);
  const year = Number(todayKey.slice(0, 4));
  const month = Number(todayKey.slice(4, 6));
  const day = Number(todayKey.slice(6, 8));
  // Anchor at UTC noon on the PT calendar date, then step back whole days.
  const anchor = Date.UTC(year, month - 1, day, 12, 0, 0);
  const keys: string[] = [];
  for (let ago = 0; ago < lookbackDays; ago++) {
    keys.push(ptDateKey(new Date(anchor - ago * 24 * 60 * 60 * 1000)));
  }
  return keys;
};

const backupUrlForDate = (dateKey: string) =>
  `${PUBLIC_BACKUP_BASE}-${dateKey}.gz`;

type AvailableBackup = {
  dateKey: string;
  url: string;
  etag: string | null;
};

/** Newest public daily backup that currently exists (HEAD), or null. */
const findNewestAvailableBackup = async (
  log: Config["log"]
): Promise<AvailableBackup | null> => {
  for (const dateKey of recentPtDateKeys()) {
    const url = backupUrlForDate(dateKey);
    const head = await headBackup(url);
    if (head.ok) {
      log.info(`Found public backup ${dateKey}`);
      return { dateKey, url, etag: head.etag };
    }
    log.info(`Backup not available yet: ${url}`);
  }
  return null;
};

const runCommand = (
  command: string,
  args: string[],
  log: Config["log"]
): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) log.info(trimmed);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.info(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });

const ensureMongorestore = async (log: Config["log"]) => {
  const version = await runCommand("mongorestore", ["--version"], log);
  if (version.code === 0) {
    const dump = await runCommand("mongodump", ["--version"], log);
    if (dump.code === 0) return;
  }
  log.info("mongo database tools missing; installing mongodb-tools via apk...");
  const install = await runCommand(
    "apk",
    ["add", "--no-cache", "mongodb-tools"],
    log
  );
  if (install.code !== 0) {
    throw new Error(`Failed to install mongodb-tools: ${install.stderr}`);
  }
};

const snapshotLocalOwnedCollections = async (
  mongoUri: string,
  snapshotDir: string,
  log: Config["log"]
): Promise<string[]> => {
  const archives: string[] = [];
  for (const collection of LOCAL_OWNED_COLLECTIONS) {
    const archivePath = path.join(snapshotDir, `local-${collection}.gz`);
    log.info(`Snapshotting local collection bt.${collection}`);
    const result = await runCommand(
      "mongodump",
      [
        `--uri=${mongoUri}`,
        "--db=bt",
        `--collection=${collection}`,
        `--archive=${archivePath}`,
        "--gzip",
      ],
      log
    );
    if (result.code !== 0) {
      log.warn(
        `Skipping snapshot for bt.${collection}: ${result.stderr.trim() || `exit ${result.code}`}`
      );
      continue;
    }
    archives.push(archivePath);
  }
  return archives;
};

const restoreLocalOwnedSnapshots = async (
  mongoUri: string,
  archives: string[],
  log: Config["log"]
) => {
  for (const archivePath of archives) {
    log.info(`Restoring local-owned snapshot ${archivePath}`);
    const result = await runCommand(
      "mongorestore",
      [
        `--uri=${mongoUri}`,
        "--gzip",
        `--archive=${archivePath}`,
        "--drop",
      ],
      log
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to restore local snapshot ${archivePath}: ${result.stderr.trim()}`
      );
    }
  }
};

/**
 * Re-seed tentative EECS terms after a public backup merge. Draft rows live in
 * shared catalog collections that --drop replaces, so exclude/snapshot can't
 * preserve them — re-apply from the stored EECS scrape instead. Terms whose
 * full schedule is now in the backup are left alone (no draft). Soft-fails
 * (warn) so a draft hiccup doesn't block enrollment restore.
 */
const reseedDraftSchedules = async (
  log: Config["log"],
  options: { syncCatalog: boolean }
): Promise<boolean> => {
  try {
    return await syncDraftSchedules(log, { refetch: false, ...options });
  } catch (error) {
    log.warn(
      `Draft schedule reseed failed (backup merge still kept): ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
    return false;
  }
};

export const invalidateBackendCaches = async (
  backendUrl: string,
  log: Config["log"]
) => {
  const url = new URL("/api/cache/invalidate-catalog", backendUrl);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      log.warn(
        `Cache invalidate returned HTTP ${response.status} from ${url.href}`
      );
      return;
    }
    log.info(`Invalidated backend catalog caches via ${url.href}`);
  } catch (error) {
    log.warn(
      `Failed to invalidate backend caches: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
};

const headBackup = async (
  url: string
): Promise<{ ok: boolean; etag: string | null }> => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { ok: false, etag: null };
    return { ok: true, etag: response.headers.get("etag") };
  } catch {
    return { ok: false, etag: null };
  }
};

const downloadBackup = async (
  url: string,
  destination: string,
  log: Config["log"]
) => {
  log.info(`Downloading ${url}`);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download backup: HTTP ${response.status}`);
  }
  const body = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream
  );
  await pipeline(body, createWriteStream(destination));
  const info = await stat(destination);
  if (info.size <= 0) {
    throw new Error(`Downloaded backup is empty: ${destination}`);
  }
  log.info(
    `Downloaded ${(info.size / (1024 * 1024)).toFixed(1)} MiB → ${destination}`
  );
};

/**
 * Replace public collections from the dump into local Mongo.
 * - --drop: drop each restored collection first (no E11000 spam; full refresh).
 * - Collections not in the archive / nsExclude'd are untouched.
 * - Local-owned collections are snapshotted and restored around this call.
 * - EECSTime-protected user data is snapshotted/re-applied around this call.
 */
const mergePublicBackup = async (
  archivePath: string,
  mongoUri: string,
  log: Config["log"]
) => {
  const args = [
    `--uri=${mongoToolsUri(mongoUri)}`,
    "--gzip",
    `--archive=${archivePath}`,
    "--drop",
    "--nsInclude=bt.*",
    ...NS_EXCLUDE.flatMap((ns) => ["--nsExclude", ns]),
  ];
  log.info(
    "Restoring public backup into local DB (--drop collections in archive; skip excluded namespaces)"
  );
  const result = await runCommand("mongorestore", args, log);
  if (result.code !== 0) {
    throw new Error(
      `mongorestore exited with code ${result.code}: ${result.stderr.trim()}`
    );
  }
};

/**
 * When classes.berkeley.edu scraping is disabled, merge berkeleytime.com's
 * public daily backup into local Mongo. Polled hourly — publish time varies,
 * so we HEAD recent PT dates and take the newest file that exists.
 */
export const syncEnrollmentFromPublicBackup = async (config: Config) => {
  const { log } = config;

  let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    lockHandle = await open(SYNC_LOCK_PATH, "wx");
  } catch {
    log.info("Another public-backup sync is already running; skipping");
    return;
  }

  try {
    await syncEnrollmentFromPublicBackupLocked(config);
  } finally {
    await lockHandle.close().catch(() => undefined);
    await unlink(SYNC_LOCK_PATH).catch(() => undefined);
  }
};

const syncEnrollmentFromPublicBackupLocked = async (config: Config) => {
  const { log } = config;

  log.info(
    `Checking for newest public backup (lookback ${BACKUP_LOOKBACK_DAYS} PT days)`
  );

  const available = await findNewestAvailableBackup(log);
  if (!available) {
    log.info("No public backup available in lookback window");
    return;
  }

  const { dateKey, url, etag } = available;

  const status =
    (await PublicBackupSyncStatusModel.findOne({
      key: SYNC_STATUS_KEY,
    }).lean()) ?? null;

  if (
    status?.lastBackupDate === dateKey &&
    status.lastEtag &&
    etag &&
    status.lastEtag === etag
  ) {
    log.info(`Already merged backup ${dateKey} (etag match); skipping restore`);
    // Still ensure tentative terms exist (or get retired) — a manual wipe may
    // have cleared them, or a real schedule may have landed.
    if (await reseedDraftSchedules(log, { syncCatalog: true })) {
      await invalidateBackendCaches(config.BACKEND_URL, log);
    }
    return;
  }

  // Prefer a strictly newer calendar date; allow same-date rematch on etag change.
  if (status?.lastBackupDate && dateKey < status.lastBackupDate) {
    log.info(
      `Newest available backup ${dateKey} is older than last merged ${status.lastBackupDate}; skipping`
    );
    if (await reseedDraftSchedules(log, { syncCatalog: true })) {
      await invalidateBackendCaches(config.BACKEND_URL, log);
    }
    return;
  }

  await ensureMongorestore(log);

  const runId = `${dateKey}-${process.pid}-${Date.now()}`;
  const archivePath = path.join("/tmp", `prod_public_backup-${runId}.gz`);
  const snapshotDir = path.join("/tmp", `bt-local-owned-${runId}`);
  try {
    await runCommand("mkdir", ["-p", snapshotDir], log);

    // Snapshot EECSTime logins before restore can replace GradTrak / reviews.
    const eecsProtection = await snapshotEecsTimeProtectedData(
      config.mongoDB.uri,
      snapshotDir,
      log
    );

    const localSnapshots = await snapshotLocalOwnedCollections(
      config.mongoDB.uri,
      snapshotDir,
      log
    );

    await downloadBackup(url, archivePath, log);
    await mergePublicBackup(archivePath, config.mongoDB.uri, log);

    // Re-apply EECSTime users + their schedules / GradTrak / reviews.
    await reapplyEecsTimeProtectedData(
      config.mongoDB.uri,
      eecsProtection,
      log
    );

    // Guarantee RMP + ASSIST survive even if exclude/filtering fails.
    await restoreLocalOwnedSnapshots(
      config.mongoDB.uri,
      localSnapshots,
      log
    );

    // Tentative EECS terms live in shared classes/sections/terms — re-seed.
    // Catalog sort fields / enrollment are synced below for every term.
    const draftReseeded = await reseedDraftSchedules(log, {
      syncCatalog: false,
    });

    // Backup catalog_classes often lack denormalized sort fields. Rebuild them
    // from source collections that are in the dump (grades, aggregated metrics)
    // plus local RMP cache (nsExcluded / snapshotted).
    log.info("Recomputing course grade summaries (incl. A/A+ percent)");
    await rebuildCourseGradeSummaries(log);
    log.info("Syncing grade summaries onto catalog_classes");
    await updateCatalogGradeSummaries(log);
    log.info("Syncing Berkeleytime rating sort fields onto catalog_classes");
    await updateCatalogRatingsForAllCatalogTerms(log);
    log.info("Re-applying RMP averages onto catalog_classes from local cache");
    await updateCatalogRmpRatings(log);

    await syncCrosslistingEnrollmentFanout(config);
    await syncCatalogEnrollmentForAllCatalogTerms(log);
    await invalidateBackendCaches(config.BACKEND_URL, log);

    await PublicBackupSyncStatusModel.findOneAndUpdate(
      { key: SYNC_STATUS_KEY },
      {
        $set: {
          lastBackupDate: dateKey,
          lastEtag: etag,
          lastRestoredAt: new Date(),
          message: `Restored public backup ${dateKey} (--drop); protected ${eecsProtection.userIds.length} EECSTime user(s); migrated GradTrak/ratings/reviews for non-EECSTime users; ${draftReseeded ? "reseeded tentative EECS terms; " : ""}synced catalog sort fields (grades, BT ratings, RMP) + enrollment`,
        },
      },
      { upsert: true }
    );

    log.info(`Public backup merge for ${dateKey} complete`);
  } finally {
    try {
      await access(archivePath);
      await unlink(archivePath);
    } catch {
      // ignore cleanup errors
    }
    await runCommand("rm", ["-rf", snapshotDir], log).catch(() => undefined);
  }
};

export default { syncEnrollmentFromPublicBackup };
