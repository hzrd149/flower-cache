// URL parsing utilities

import { isHexKey } from "applesauce-core/helpers";
import type { ParsedRequest } from "./types";

/**
 * Parse request URL to extract sha256 hash, extension, and query parameters
 * Supports format: /<sha256>[.ext][?as=<pubkey>&sx=<server>]
 */
export function parseRequest(url: URL): ParsedRequest | null {
  // Extract pathname (remove leading slash)
  const pathname = url.pathname.slice(1);

  // Match pattern: <sha256>[.ext]
  // sha256 is 64 hex characters
  const sha256Pattern = /^([a-f0-9]{64})(\.[a-zA-Z0-9]+)?$/i;
  const match = pathname.match(sha256Pattern);

  if (!match) {
    return null;
  }

  const sha256 = match[1]!.toLowerCase();
  const extension = match[2] || undefined;

  // Extract query parameters
  const authorPubkeys = url.searchParams.getAll("as").filter(isHexKey);
  const serverHints = url.searchParams
    .getAll("sx")
    .map((s) => (s.startsWith("http") ? s : `https://${s}`));

  return {
    sha256,
    extension,
    authorPubkeys,
    serverHints,
  };
}
