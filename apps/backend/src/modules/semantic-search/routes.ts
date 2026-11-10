import { type Response, Router } from "express";

import { config } from "../../../../../packages/common/src/utils/config";
import { searchCourses } from "./controller";

const router = Router();
const baseUrl = config.semanticSearch.url.replace(/\/$/, "");

async function forward(
  target: string,
  init: RequestInit,
  res: Response
): Promise<void> {
  try {
    const response = await fetch(target, init);
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();

    if (contentType.includes("application/json")) {
      const payload = raw ? JSON.parse(raw) : {};
      res.status(response.status).json(payload);
    } else {
      res.status(response.status).send(raw);
    }
  } catch (error) {
    console.error("Semantic search proxy error:", error);
    res.status(502).json({
      error: "Unable to reach semantic search service",
      details: String(error),
    });
  }
}

/**
 * The catalog checks this on every visit. When the semantic-search service
 * isn't running (it's an optional compose profile), fail fast and remember
 * the failure briefly instead of making each visitor wait on a timeout.
 */
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_FAILURE_TTL_MS = 60_000;
let healthFailedAt = 0;

router.get("/health", async (_req, res) => {
  if (Date.now() - healthFailedAt < HEALTH_FAILURE_TTL_MS) {
    res.status(503).json({ error: "Semantic search unavailable", indexes: [] });
    return;
  }
  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const raw = await response.text();
    res
      .status(response.status)
      .type(response.headers.get("content-type") ?? "application/json")
      .send(raw);
  } catch {
    healthFailedAt = Date.now();
    res.status(503).json({ error: "Semantic search unavailable", indexes: [] });
  }
});

router.post("/refresh", async (req, res) => {
  const body = req.body ?? {};
  await forward(
    `${baseUrl}/refresh`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    res
  );
});

// Lightweight endpoint: returns only course identifiers for frontend filtering
router.get("/courses", searchCourses);

// Full proxy endpoint (kept for backwards compatibility)
router.post("/search", async (req, res) => {
  const body = req.body ?? {};
  if (!body.query || !String(body.query).trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  await forward(
    `${baseUrl}/search`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    res
  );
});

export default router;
