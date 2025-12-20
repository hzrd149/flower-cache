// Blossom Proxy Server
// Implements BUD-01 and BUD-10 URL schemas for blob proxying and caching

import { PORT, CACHE_DIR } from "./src/config";
import { parseRequest } from "./src/parser";
import { handleBlobRequest } from "./src/handler";
import { createErrorResponse } from "./src/response";

// Main server
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Handle OPTIONS requests for CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE",
          "Access-Control-Allow-Headers": "Authorization, *",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Handle GET and HEAD requests
    if (req.method === "GET" || req.method === "HEAD") {
      const parsed = parseRequest(url);

      if (!parsed) {
        return createErrorResponse(400, "Invalid request: expected /<sha256>[.ext] format");
      }

      try {
        return await handleBlobRequest(req, parsed);
      } catch (error) {
        console.error("Error handling request:", error);
        return createErrorResponse(
          500,
          `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    // Method not allowed
    return createErrorResponse(405, "Method not allowed");
  },
});

console.log(`Blossom proxy server running at ${server.url}`);
console.log(`Cache directory: ${CACHE_DIR}`);
