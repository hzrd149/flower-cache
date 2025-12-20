// Author server resolution (BUD-03)

import { getAuthorServers } from "./nostr";

/**
 * Resolve author's server list from their pubkey
 * Uses BUD-03 server list resolution (kind:10063)
 */
export async function resolveAuthorServers(pubkey: string): Promise<string[]> {
  try {
    const servers = await getAuthorServers(pubkey);
    // Convert URL[] to string[] using .href
    return servers.map((url) => url.href);
  } catch (error) {
    // Return empty array if resolution fails
    return [];
  }
}
