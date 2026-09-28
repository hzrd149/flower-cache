import {
  BLOSSOM_SERVER_LIST_KIND,
  getBlossomServersFromList,
} from "applesauce-common/helpers";
import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import { lastValueFrom, takeUntil, timer, toArray } from "rxjs";
import {
  LOOKUP_RELAYS,
  NEGATIVE_CACHE_MAX_ENTRIES,
  NEGATIVE_CACHE_TTL,
  USER_SERVER_LIST_TIMEOUT,
} from "./config";

export const eventStore = new EventStore();
export const pool = new RelayPool();

// Pubkeys whose server list lookup found nothing, mapped to when to retry.
// Without this every new blob for an author with no kind:10063 list would pay
// for a fresh relay round-trip.
const missingLists = new Map<string, number>();

// Concurrent requests for the same author share one relay lookup.
const inFlight = new Map<string, Promise<URL[]>>();

/** Gets the blossom server list of an author */
export async function getAuthorServers(pubkey: string): Promise<URL[]> {
  const cached = eventStore.getReplaceable(BLOSSOM_SERVER_LIST_KIND, pubkey);
  if (cached) return getBlossomServersFromList(cached);

  const retryAt = missingLists.get(pubkey);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return [];
    missingLists.delete(pubkey);
  }

  let lookup = inFlight.get(pubkey);
  if (!lookup) {
    lookup = lookupAuthorServers(pubkey).finally(() => inFlight.delete(pubkey));
    inFlight.set(pubkey, lookup);
  }

  return lookup;
}

/**
 * Ask the lookup relays for an author's server list. Finishes as soon as every
 * relay has sent EOSE (or failed), so an author without a list costs one relay
 * round-trip instead of the whole USER_SERVER_LIST_TIMEOUT, which only caps
 * unresponsive relays.
 */
async function lookupAuthorServers(pubkey: string): Promise<URL[]> {
  const events = await lastValueFrom(
    pool
      .request(LOOKUP_RELAYS, {
        kinds: [BLOSSOM_SERVER_LIST_KIND],
        authors: [pubkey],
      })
      .pipe(takeUntil(timer(USER_SERVER_LIST_TIMEOUT)), toArray()),
  );

  // The store keeps only the newest version of the replaceable event
  for (const event of events) eventStore.add(event);

  const list = eventStore.getReplaceable(BLOSSOM_SERVER_LIST_KIND, pubkey);
  if (list) return getBlossomServersFromList(list);

  if (NEGATIVE_CACHE_TTL > 0) {
    missingLists.set(pubkey, Date.now() + NEGATIVE_CACHE_TTL);

    // Pubkeys come from request URLs, so bound the map (oldest first)
    while (missingLists.size > NEGATIVE_CACHE_MAX_ENTRIES) {
      const oldest = missingLists.keys().next().value;
      if (oldest === undefined) break;
      missingLists.delete(oldest);
    }
  }
  return [];
}
