// Security utilities for request validation

import { createErrorResponse } from "./response";

/**
 * Check if a request comes from localhost (127.0.0.1 or ::1)
 * @param req - The request object
 * @param server - The Bun server instance (needed to get remote IP)
 * @returns null if localhost, or a 403 Forbidden response if not
 */
export function validateLocalhost(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null },
): Response | null {
  const ipInfo = server.requestIP(req);
  if (!ipInfo) {
    return createErrorResponse(403, "Unable to determine request origin");
  }

  const address = ipInfo.address;
  const isLocalhost =
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.") ||
    address === "localhost";

  if (!isLocalhost) {
    return createErrorResponse(
      403,
      "Upload and delete endpoints are only accessible from localhost",
    );
  }

  return null;
}
