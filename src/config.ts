// Configuration constants

import { relaySet } from "applesauce-core/helpers";

/** Cache directory path */
export const CACHE_DIR = Bun.env.CACHE_DIR || "./cache";

/** Server port */
export const PORT = Bun.env.PORT ? parseInt(Bun.env.PORT, 10) : 24242;

/** Upstream request timeout in milliseconds (per server attempt) */
export const REQUEST_TIMEOUT = Bun.env.REQUEST_TIMEOUT
  ? parseInt(Bun.env.REQUEST_TIMEOUT, 10)
  : 10000; // 10 seconds

/**
 * Total time budget for a single download across ALL upstream server attempts.
 * Bounds worst-case cost of one download to a constant regardless of how many
 * candidate servers exist, so a miss can't burn REQUEST_TIMEOUT × N_servers.
 */
export const DOWNLOAD_BUDGET = Bun.env.DOWNLOAD_BUDGET
  ? parseInt(Bun.env.DOWNLOAD_BUDGET, 10)
  : 30000; // 30 seconds

/**
 * How long (ms) to remember that a blob was not found upstream, so repeated
 * requests for the same missing hash are answered instantly with 404 instead
 * of re-hunting every upstream server. Set to 0 to disable negative caching.
 */
export const NEGATIVE_CACHE_TTL = Bun.env.NEGATIVE_CACHE_TTL
  ? parseInt(Bun.env.NEGATIVE_CACHE_TTL, 10)
  : 60000; // 60 seconds

/** Maximum number of distinct missing hashes to remember (bounds memory). */
export const NEGATIVE_CACHE_MAX_ENTRIES = Bun.env.NEGATIVE_CACHE_MAX_ENTRIES
  ? parseInt(Bun.env.NEGATIVE_CACHE_MAX_ENTRIES, 10)
  : 10000;

/**
 * Maximum number of downloads that may be queued waiting for a free worker.
 * Requests beyond this are rejected with 503 so distinct-hash spam can't grow
 * the queue (and upstream fan-out) without bound.
 */
export const MAX_DOWNLOAD_QUEUE = Bun.env.MAX_DOWNLOAD_QUEUE
  ? parseInt(Bun.env.MAX_DOWNLOAD_QUEUE, 10)
  : 100;

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

/** Allowed IP addresses and CIDR ranges for upload/delete endpoints */
export const ALLOWED_UPLOAD_IPS: string[] = Bun.env.ALLOWED_UPLOAD_IPS
  ? Bun.env.ALLOWED_UPLOAD_IPS.split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0)
  : ["127.0.0.0/8", "::1", "::ffff:127.0.0.1"];

/** Number of download worker threads */
export const DOWNLOAD_WORKERS = Math.max(
  1,
  Bun.env.DOWNLOAD_WORKERS
    ? parseInt(Bun.env.DOWNLOAD_WORKERS, 10) || 1
    : navigator.hardwareConcurrency || 1,
);
