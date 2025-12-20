// Configuration constants

import { relaySet } from "applesauce-core/helpers";

/** Cache directory path */
export const CACHE_DIR = Bun.env.CACHE_DIR || "./cache";

/** Server port */
export const PORT = Bun.env.PORT ? parseInt(Bun.env.PORT, 10) : 3000;

/** Upstream request timeout in milliseconds */
export const REQUEST_TIMEOUT = Bun.env.REQUEST_TIMEOUT
  ? parseInt(Bun.env.REQUEST_TIMEOUT, 10)
  : 30000; // 30 seconds

/** Maximum redirect following depth */
export const MAX_REDIRECTS = Bun.env.MAX_REDIRECTS
  ? parseInt(Bun.env.MAX_REDIRECTS, 10)
  : 5;

export const USER_SERVER_LIST_TIMEOUT = Bun.env.USER_SERVER_LIST_TIMEOUT
  ? parseInt(Bun.env.USER_SERVER_LIST_TIMEOUT, 10)
  : 20000; // 20 seconds

/** List of relays to use for looking up author servers */
export const LOOKUP_RELAYS = Bun.env.LOOKUP_RELAYS
  ? relaySet(Bun.env.LOOKUP_RELAYS.split(",").map((r) => r.trim()))
  : [];

/** Extra servers to use for fetching blobs */
export const FALLBACK_SERVERS = Bun.env.FALLBACK_SERVERS
  ? Bun.env.FALLBACK_SERVERS.split(",")
      .map((r) => r.trim())
      .filter((r) => URL.canParse(r))
      .map((r) => new URL(r))
  : [];
