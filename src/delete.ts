// Delete handler for BUD-02 DELETE /<sha256> endpoint

import { createErrorResponse } from "./response";
import { deleteBlobFromCache } from "./cache";
import { validateLocalhost } from "./security";

/**
 * Handle DELETE /<sha256> request
 * @param req - The request object
 * @param sha256 - The SHA-256 hash from the URL path
 * @param server - The Bun server instance (for IP validation)
 * @returns Response indicating success or error
 */
export async function handleDeleteRequest(
  req: Request,
  sha256: string,
  server: { requestIP: (req: Request) => { address: string } | null },
): Promise<Response> {
  // Validate localhost
  const localhostError = validateLocalhost(req, server);
  if (localhostError) {
    return localhostError;
  }

  // Validate SHA-256 format (64 hex characters)
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    return createErrorResponse(400, "Invalid SHA-256 hash format");
  }

  const normalizedHash = sha256.toLowerCase();

  try {
    const deleted = await deleteBlobFromCache(normalizedHash);
    if (deleted) {
      console.log(`[${normalizedHash}] ✓ Deleted from cache`);
      return new Response(null, { status: 204 });
    } else {
      return createErrorResponse(404, "Blob not found");
    }
  } catch (error) {
    console.error(`[${normalizedHash}] Delete error:`, error);
    return createErrorResponse(
      500,
      `Delete failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
