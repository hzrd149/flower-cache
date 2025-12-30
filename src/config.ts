// Configuration constants

import { relaySet } from "applesauce-core/helpers";

/** Cache directory path */
export const CACHE_DIR = Bun.env.CACHE_DIR || "./cache";

/** Server port */
export const PORT = Bun.env.PORT ? parseInt(Bun.env.PORT, 10) : 24242;

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

/**
 * Parse size string (e.g., "10GB", "500MB", "1TB") into bytes
 * @returns Size in bytes, or null if invalid format
 */
function parseSize(sizeStr: string): number | null {
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();

  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };

  const multiplier = multipliers[unit];
  if (!multiplier) return null;

  return Math.floor(value * multiplier);
}

/** Maximum cache size in bytes (null = no limit) */
export const MAX_CACHE_SIZE: number | null = Bun.env.MAX_CACHE_SIZE
  ? parseSize(Bun.env.MAX_CACHE_SIZE)
  : null;
