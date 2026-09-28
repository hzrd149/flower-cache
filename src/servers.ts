import { mergeBlossomServers } from "applesauce-common/helpers";
import { FALLBACK_SERVERS, LOOKUP_RELAYS } from "./config";
import { resolveAuthorServers } from "./author";

/**
 * Normalize a server URL by adding protocol if missing.
 * Returns the URL with https:// protocol preferred.
 */
function normalizeServerUrlForMerge(server: string): string {
  if (server.startsWith("http://") || server.startsWith("https://")) {
    return server;
  }

  return `https://${server}`;
}

export async function resolveCandidateServers(
  authorPubkeys: string[],
  serverHints: string[],
): Promise<string[]> {
  const allServers: string[] = [...serverHints].map(normalizeServerUrlForMerge);

  if (authorPubkeys.length > 0 && LOOKUP_RELAYS.length > 0) {
    // Look authors up in parallel, but keep their servers in request order
    const authorServers = await Promise.all(
      authorPubkeys.map(resolveAuthorServers),
    );
    for (const servers of authorServers) {
      allServers.push(...servers.map(normalizeServerUrlForMerge));
    }
  }

  allServers.push(...FALLBACK_SERVERS.map((url) => url.href));

  return mergeBlossomServers(allServers);
}
