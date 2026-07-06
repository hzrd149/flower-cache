// Negative cache for blobs that were confirmed missing from all upstream servers.
//
// Without this, a client polling for a not-yet-existent blob (a normal Blossom
// pattern) causes the server to re-hunt every upstream server every time the
// in-flight download resolves — unbounded amplification. Remembering the "not
// found" verdict for a short TTL lets us answer repeat requests with an instant
// 404 instead.

import { NEGATIVE_CACHE_TTL, NEGATIVE_CACHE_MAX_ENTRIES } from "./config";

// Map is insertion-ordered, which we exploit for cheap oldest-first eviction.
const missing = new Map<string, number>();

/**
 * Whether this hash is currently remembered as missing. Lazily expires the
 * entry when its TTL has passed.
 */
export function isKnownMissing(sha256: string): boolean {
  if (NEGATIVE_CACHE_TTL <= 0) return false;

  const expiry = missing.get(sha256);
  if (expiry === undefined) return false;

  if (Date.now() >= expiry) {
    missing.delete(sha256);
    return false;
  }

  return true;
}

/** Remember that a blob was not found upstream. */
export function markMissing(sha256: string): void {
  if (NEGATIVE_CACHE_TTL <= 0) return;

  // Re-insert to move to the end (most-recent) of the insertion order.
  missing.delete(sha256);
  missing.set(sha256, Date.now() + NEGATIVE_CACHE_TTL);

  if (missing.size > NEGATIVE_CACHE_MAX_ENTRIES) {
    evictOldest();
  }
}

/**
 * Forget a missing verdict — call when a blob becomes available (e.g. upload)
 * so we don't serve a stale 404 for up to the TTL.
 */
export function clearMissing(sha256: string): void {
  missing.delete(sha256);
}

function evictOldest(): void {
  const now = Date.now();

  // Prefer dropping already-expired entries.
  for (const [hash, expiry] of missing) {
    if (now >= expiry) missing.delete(hash);
  }

  // If still over the cap, drop oldest-inserted entries until under it.
  while (missing.size > NEGATIVE_CACHE_MAX_ENTRIES) {
    const oldest = missing.keys().next().value;
    if (oldest === undefined) break;
    missing.delete(oldest);
  }
}
