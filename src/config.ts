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
 * How long (ms) an upstream body transfer may make no progress at all before
 * it is aborted. DOWNLOAD_BUDGET only bounds the search for a server; without
 * this, an upstream that sends headers and then trickles (or nothing) pins a
 * download worker forever.
 */
export const DOWNLOAD_STALL_TIMEOUT = Bun.env.DOWNLOAD_STALL_TIMEOUT
  ? parseInt(Bun.env.DOWNLOAD_STALL_TIMEOUT, 10)
  : 15000; // 15 seconds

/**
 * Minimum sustained throughput (bytes/second) an upstream transfer must hold,
 * measured once it has been running for DOWNLOAD_STALL_TIMEOUT. Stops a drip
 * that is slow but too regular to trip the stall timer.
 */
export const DOWNLOAD_MIN_SPEED = Bun.env.DOWNLOAD_MIN_SPEED
  ? parseInt(Bun.env.DOWNLOAD_MIN_SPEED, 10)
  : 16 * 1024; // 16 KiB/s

/**
 * Hard ceiling (ms) on a single blob transfer, regardless of throughput. Bounds
 * how long one request can occupy a download worker.
 */
export const DOWNLOAD_MAX_DURATION = Bun.env.DOWNLOAD_MAX_DURATION
  ? parseInt(Bun.env.DOWNLOAD_MAX_DURATION, 10)
  : 1800000; // 30 minutes

/**
 * How long (ms) a download may sit waiting for a free worker before the caller
 * is rejected with 503. Without it, a saturated pool leaves clients hanging.
 */
export const DOWNLOAD_QUEUE_TIMEOUT = Bun.env.DOWNLOAD_QUEUE_TIMEOUT
  ? parseInt(Bun.env.DOWNLOAD_QUEUE_TIMEOUT, 10)
  : 30000; // 30 seconds

/**
 * Backstop (ms) covering a download's entire life: queue wait plus execution.
 * The worker is expected to bound itself first, so this only fires when a
 * worker has genuinely stopped responding — the caller gets a 504 and the
 * worker is replaced rather than the request hanging forever.
 */
export const DOWNLOAD_JOB_TIMEOUT = Bun.env.DOWNLOAD_JOB_TIMEOUT
  ? parseInt(Bun.env.DOWNLOAD_JOB_TIMEOUT, 10)
  : DOWNLOAD_BUDGET + DOWNLOAD_MAX_DURATION + 30000;

/**
 * Seconds a connection may sit without traffic before Bun closes it. Bun's
 * 10s default silently drops any request whose upstream fetch runs longer —
 * including the 503/504 the download pool produces — so the caller sees a
 * dead socket instead of an answer. Bun caps this at 255 seconds.
 */
export const REQUEST_IDLE_TIMEOUT = Math.min(
  255,
  Math.max(
    0,
    Bun.env.REQUEST_IDLE_TIMEOUT
      ? parseInt(Bun.env.REQUEST_IDLE_TIMEOUT, 10) || 0
      : 120,
  ),
);

/** Delay (ms) before replacing a lost download worker; rate-limits crash loops. */
export const WORKER_RESPAWN_DELAY = Bun.env.WORKER_RESPAWN_DELAY
  ? parseInt(Bun.env.WORKER_RESPAWN_DELAY, 10)
  : 1000;

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

/**
 * Parse size string (e.g., "10GB", "500MB", "1TB") into bytes
 * @returns Size in bytes, or null if invalid format
 */
export function parseSize(sizeStr: string): number | null {
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

/**
 * Whether a cache miss may stream upstream bytes to the client while they are
 * still being written and hashed. Time-to-first-byte on a miss otherwise equals
 * the entire upstream transfer. Set to "false" to restore store-and-forward.
 */
export const STREAM_THROUGH = Bun.env.STREAM_THROUGH
  ? Bun.env.STREAM_THROUGH !== "false" && Bun.env.STREAM_THROUGH !== "0"
  : true;

/**
 * Upstream Content-Length at or above which a miss is streamed through. Below
 * it the blob is downloaded, verified and only then served — that path is
 * already fast at small sizes and keeps both multi-server failover and the
 * guarantee that served bytes match the requested hash. An upstream that
 * declares no length is treated as large, since that is exactly the case where
 * blocking hurts most.
 */
export const STREAM_THROUGH_MIN_SIZE: number = Bun.env.STREAM_THROUGH_MIN_SIZE
  ? (parseSize(Bun.env.STREAM_THROUGH_MIN_SIZE) ?? 2 * 1024 * 1024)
  : 2 * 1024 * 1024; // 2MB

/**
 * How many chunks a download worker may push to the main thread before waiting
 * for the response stream to ask for more. Bounds the bytes held in memory for
 * a client that reads slower than the upstream sends.
 */
export const STREAM_CHUNK_CREDITS = Math.max(
  1,
  Bun.env.STREAM_CHUNK_CREDITS
    ? parseInt(Bun.env.STREAM_CHUNK_CREDITS, 10) || 8
    : 8,
);

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
