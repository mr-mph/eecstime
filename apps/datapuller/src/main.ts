import { parseArgs } from "node:util";

import {
  syncCatalogEnrollmentForAllCatalogTerms,
  updateCatalogGradeSummaries,
  updateCatalogRatingsForAllCatalogTerms,
} from "./lib/catalog-denormalize";
import articulationsPuller from "./pullers/articulations";
import classesPuller from "./pullers/classes";
import coursesPuller from "./pullers/courses";
import decalsPuller from "./pullers/decals";
import eecsDraftSchedulePuller from "./pullers/eecs-draft-schedule";
import enrollmentFromPublicBackupPuller from "./pullers/enrollment-from-public-backup";
import enrollmentHistoriesPuller from "./pullers/enrollment";
import enrollmentTimeframePuller from "./pullers/enrollment-timeframe";
import crosslistingEnrollmentFanoutPuller from "./pullers/crosslisting-enrollment-fanout";
import gradeDistributionsPuller, {
  rebuildCourseGradeSummaries,
} from "./pullers/grade-distributions";
import migrationsPuller from "./pullers/migrations";
import rateMyProfessorsPuller from "./pullers/ratemyprofessors";
import sectionsPuller from "./pullers/sections";
import termsPuller from "./pullers/terms";
import ucbCatalogEnrollmentsPuller from "./pullers/ucb-catalog-enrollments";
import setup from "./shared";
import { Config } from "./shared/config";

const cliArgs = {
  puller: {
    type: "string" as const,
  },
} as const;

/** Rebuild denormalized catalog sort fields from source collections. */
const syncCatalogSortFields = async (config: Config) => {
  await rebuildCourseGradeSummaries(config.log);
  await updateCatalogGradeSummaries(config.log);
  await updateCatalogRatingsForAllCatalogTerms(config.log);
};

const pullerMap: {
  [key: string]: (config: Config, ...arg: any) => Promise<unknown>;
} = {
  articulations: articulationsPuller.updateArticulations,
  courses: coursesPuller.updateCourses,
  decals: decalsPuller.scrapeDeCals,
  "sections-active": sectionsPuller.activeTerms,
  "sections-last-five-years": sectionsPuller.lastFiveYearsTerms,
  "classes-active": classesPuller.activeTerms,
  "classes-last-five-years": classesPuller.lastFiveYearsTerms,
  "grades-recent": gradeDistributionsPuller.recentPastTerms,
  "grades-last-five-years": gradeDistributionsPuller.lastFiveYearsTerms,
  enrollments: enrollmentHistoriesPuller.updateEnrollmentHistories,
  "enrollment-timeframe": enrollmentTimeframePuller.syncEnrollmentTimeframe,
  "enrollment-from-public-backup":
    enrollmentFromPublicBackupPuller.syncEnrollmentFromPublicBackup,
  "eecs-draft-schedule": eecsDraftSchedulePuller.syncEecsDraftSchedule,
  "crosslisting-enrollment-fanout":
    crosslistingEnrollmentFanoutPuller.syncCrosslistingEnrollmentFanout,
  "terms-all": termsPuller.allTerms,
  "terms-nearby": termsPuller.nearbyTerms,
  "migrate-aggregated-metrics-classid":
    migrationsPuller.backfillAggregatedMetricsClassId,
  "catalog-sync-grades": async (config: Config) =>
    updateCatalogGradeSummaries(config.log),
  "catalog-sync-sort-fields": syncCatalogSortFields,
  "catalog-sync-enrollment": async (config: Config) => {
    await syncCatalogEnrollmentForAllCatalogTerms(config.log);
    const url = new URL("/api/cache/invalidate-catalog", config.BACKEND_URL);
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      config.log.warn(
        `Cache invalidate returned HTTP ${response.status} from ${url.href}`
      );
    }
  },
  ratemyprofessors: rateMyProfessorsPuller.syncRateMyProfessors,
  "ucb-catalog-enrollments":
    ucbCatalogEnrollmentsPuller.syncUcbCatalogEnrollments,
} as const;

const runPuller = async () => {
  const { values: args } = parseArgs({ options: cliArgs });

  if (!args.puller || !pullerMap[args.puller]) {
    throw new Error(
      "Please specify a valid puller argument: " +
        Object.keys(pullerMap).join(", ")
    );
  }

  const { config } = await setup();
  const logger = config.log.getSubLogger({ name: "PullerRunner" });
  try {
    logger.info(
      `Starting ${args.puller} puller with args: ${JSON.stringify(args)}`
    );

    await pullerMap[args.puller](config);

    logger.trace(`${args.puller} puller completed successfully`);
    process.exit(0);
  } catch (error: any) {
    logger.error(`${args.puller} puller failed: ${error.message}`);
    process.exit(1);
  }
};

runPuller();
