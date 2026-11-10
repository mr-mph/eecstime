/**
 * Rough visitor analytics.
 *
 *   POST /analytics/heartbeat  { visitorId }   record a visit (204, no data)
 *   GET  /analytics/summary                    counts for the /analytics page
 *
 * The frontend sends a FingerprintJS visitorId on load and every minute while
 * the tab is visible. Counts are kept in a JSON file and logged hourly (see
 * store.ts). The summary only has aggregate counts, never visitor ids.
 */
import { type Application, type Request, type Response } from "express";

import { presenceStore, startAnalyticsLogging } from "./store";

const BOT_UA = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget/i;

/** Client IP through Cloudflare -> nginx -> backend. */
const clientIp = (req: Request) => {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "";
};

export default (app: Application) => {
  startAnalyticsLogging();

  app.post("/analytics/heartbeat", (req: Request, res: Response) => {
    const fingerprint = req.body?.visitorId;
    const userAgent = req.headers["user-agent"] ?? "";
    if (
      typeof fingerprint !== "string" ||
      fingerprint.length === 0 ||
      fingerprint.length > 128
    ) {
      res.status(400).json({ error: "visitorId required" });
      return;
    }
    if (!BOT_UA.test(userAgent)) {
      presenceStore.touch(
        presenceStore.visitorId(fingerprint, clientIp(req), userAgent)
      );
    }
    res.status(204).end();
  });

  app.get("/analytics/summary", (_req: Request, res: Response) => {
    const now = Date.now();
    res.set("Cache-Control", "no-store");
    res.status(200).json({
      generatedAt: new Date(now).toISOString(),
      timezone: "America/Los_Angeles",
      totals: presenceStore.summary(now),
      hourly: presenceStore.hourly(now, 48),
      daily: presenceStore.daily(now, 90),
    });
  });
};
