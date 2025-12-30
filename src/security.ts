// Security utilities for request validation

import { createErrorResponse } from "./response";
import { ALLOWED_UPLOAD_IPS } from "./config";
import ipRangeCheck from "ip-range-check";

/**
 * Check if a request comes from an allowed IP address or CIDR range
 * @param req - The request object
 * @param server - The Bun server instance (needed to get remote IP)
 * @returns null if allowed, or a 403 Forbidden response if not
 */
export function validateAllowedIP(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null },
): Response | null {
  const ipInfo = server.requestIP(req);
  if (!ipInfo) {
    return createErrorResponse(403, "Unable to determine request origin");
  }

  const address = ipInfo.address;

  // Check if the IP matches any allowed IP or CIDR range
  try {
    const isAllowed = ipRangeCheck(address, ALLOWED_UPLOAD_IPS);
    if (!isAllowed) {
      return createErrorResponse(
        403,
        "Upload and delete endpoints are only accessible from allowed IP addresses",
      );
    }
  } catch (error) {
    // If ip-range-check throws an error (e.g., invalid IP format), deny access
    console.warn(
      `[Security] Error checking IP ${address} against allowlist:`,
      error,
    );
    return createErrorResponse(403, "Unable to validate request origin");
  }

  return null;
}
