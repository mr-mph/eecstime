import { syncDraftSchedules } from "../lib/draft-schedule";
import { Config } from "../shared/config";
import { invalidateBackendCaches } from "./enrollment-from-public-backup";

/**
 * Daily: scrape the EECS draft schedule pages and load any upcoming term that
 * has no real schedule yet as a tentative "(Only for EECS)" term. Terms whose
 * full schedule has landed get their draft rows removed.
 */
const syncEecsDraftSchedule = async (config: Config) => {
  const changed = await syncDraftSchedules(config.log, { refetch: true });
  if (changed) await invalidateBackendCaches(config.BACKEND_URL, config.log);
};

export default { syncEecsDraftSchedule };
