import type { RedisClientType } from "redis";

const LAST_REQUEST_KEY = "ucb-catalog:last-request-at";

/**
 * Atomically claim the next outbound slot to classes.berkeley.edu.
 * Returns milliseconds to wait before retrying (0 = claimed).
 */
const ACQUIRE_SLOT_LUA = `
local key = KEYS[1]
local interval = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local last = tonumber(redis.call('GET', key) or '0')
local earliest = last + interval
if now < earliest then
  return earliest - now
end
redis.call('SET', key, tostring(now))
return 0
`;

/**
 * Wait until this process may send the next HTTP request to
 * classes.berkeley.edu (global across backend replicas via Redis).
 */
export async function waitForUcbCatalogSlot(
  redis: RedisClientType,
  minIntervalMs: number
): Promise<void> {
  for (;;) {
    const waitMs = Number(
      await redis.eval(ACQUIRE_SLOT_LUA, {
        keys: [LAST_REQUEST_KEY],
        arguments: [String(minIntervalMs), String(Date.now())],
      })
    );
    if (waitMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}
