import type { RedisClientType } from "redis";
import { GraphQLError } from "graphql";

import {
  ParsedUcbCatalogEnrollment,
  UcbCatalogEnrollmentError,
  buildUcbCatalogUrl as sharedBuildUcbCatalogUrl,
  fetchUcbCatalogEnrollment as sharedFetchUcbCatalogEnrollment,
  isBlankUcbEnrollment as sharedIsBlankUcbEnrollment,
  mergeSeatReservationTypes as sharedMergeSeatReservationTypes,
  seatReservationCountsEqual as sharedSeatReservationCountsEqual,
  preserveRemovedSeatReservationCounts as sharedPreserveRemovedSeatReservationCounts,
} from "@repo/shared";

import { createRequestQueue } from "../../utils/requestQueue";
import { waitForUcbCatalogSlot } from "../../utils/ucbCatalogRateLimit";

export type {
  ParsedUcbCatalogEnrollment,
  ParsedUcbEnrollment,
} from "@repo/shared";

export const buildUcbCatalogUrl = sharedBuildUcbCatalogUrl;
export const isBlankUcbEnrollment = sharedIsBlankUcbEnrollment;
export const mergeSeatReservationTypes = sharedMergeSeatReservationTypes;
export const seatReservationCountsEqual = sharedSeatReservationCountsEqual;
export const preserveRemovedSeatReservationCounts =
  sharedPreserveRemovedSeatReservationCounts;

/** Cap outbound traffic to classes.berkeley.edu at 1 request / 3s. */
const UCB_CATALOG_MIN_INTERVAL_MS = 3000;

/**
 * Local FIFO so concurrent GraphQL handlers on this process wait in line
 * before competing for the Redis slot (avoids thundering-herd sleep loops).
 */
const enqueueLocally = createRequestQueue(0);

function mapUcbError(error: unknown): never {
  if (error instanceof UcbCatalogEnrollmentError) {
    throw new GraphQLError(error.message, {
      extensions: { code: error.code },
    });
  }
  if (error instanceof GraphQLError) {
    throw error;
  }
  throw new GraphQLError(
    error instanceof Error ? error.message : "Berkeley Catalog scrape failed",
    { extensions: { code: "INTERNAL_SERVER_ERROR" } }
  );
}

function createRateLimitedFetch(
  redis: RedisClientType
): typeof globalThis.fetch {
  return (input, init) =>
    enqueueLocally(async () => {
      await waitForUcbCatalogSlot(redis, UCB_CATALOG_MIN_INTERVAL_MS);
      return globalThis.fetch(input, init);
    });
}

export async function fetchUcbCatalogEnrollment(
  url: string,
  redis: RedisClientType
): Promise<ParsedUcbCatalogEnrollment> {
  try {
    return await sharedFetchUcbCatalogEnrollment(url, {
      fetch: createRateLimitedFetch(redis),
    });
  } catch (error) {
    mapUcbError(error);
  }
}
