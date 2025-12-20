import {
  BLOSSOM_SERVER_LIST_KIND,
  getBlossomServersFromList,
} from "applesauce-common/helpers";
import { defined, EventStore, firstValueFrom } from "applesauce-core";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { map, timeout } from "rxjs";
import { LOOKUP_RELAYS, USER_SERVER_LIST_TIMEOUT } from "./config";

export const eventStore = new EventStore();
export const pool = new RelayPool();

createEventLoaderForStore(eventStore, pool, {
  lookupRelays: LOOKUP_RELAYS,
});

/** Gets the blossom server list of an author */
export async function getAuthorServers(pubkey: string): Promise<URL[]> {
  const cached = eventStore.getReplaceable(BLOSSOM_SERVER_LIST_KIND, pubkey);
  if (cached) return getBlossomServersFromList(cached);

  return firstValueFrom(
    eventStore
      .replaceable(BLOSSOM_SERVER_LIST_KIND, pubkey)
      .pipe(
        defined(),
        timeout({ first: USER_SERVER_LIST_TIMEOUT }),
        map(getBlossomServersFromList),
      ),
  );
}
