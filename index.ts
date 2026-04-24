#!/usr/bin/env bun
import { PORT, CACHE_DIR, DOWNLOAD_WORKERS } from "./src/config";
import { parseRequest } from "./src/parser";
import { handleBlobRequest } from "./src/handler";
import { handleUploadRequest } from "./src/upload";
import { handleDeleteRequest } from "./src/delete";
import {
  addCorsHeaders,
  CORS_HEADERS,
  createErrorResponse,
} from "./src/response";
import { initializeCache } from "./src/cache";
import { generateStatsPage } from "./src/stats";
import {
  initializeDownloadWorkerPool,
  terminateDownloadWorkerPool,
} from "./src/worker-pool";

await initializeCache();
initializeDownloadWorkerPool(DOWNLOAD_WORKERS);

// Main server
const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // Handle OPTIONS requests for CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Handle GET / requests - serve stats page
    if (req.method === "GET" && url.pathname === "/") {
      try {
        const html = await generateStatsPage();
        return addCorsHeaders(
          new Response(html, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          }),
        );
      } catch (error) {
        console.error("Error generating stats page:", error);
        return createErrorResponse(
          500,
          `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    // Handle HEAD / requests - health check
    if (req.method === "HEAD" && url.pathname === "/") {
      return addCorsHeaders(
        new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        }),
      );
    }

    // Handle PUT /upload requests (BUD-02)
    if (req.method === "PUT" && url.pathname === "/upload") {
      try {
        return await handleUploadRequest(req, server);
      } catch (error) {
        console.error("Error handling upload request:", error);
        return createErrorResponse(
          500,
          `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    // Handle DELETE /<sha256> requests (BUD-02)
    if (req.method === "DELETE") {
      // Extract SHA-256 from pathname (remove leading slash)
      const pathname = url.pathname.slice(1);
      const sha256Match = pathname.match(/^([a-f0-9]{64})$/i);

      if (!sha256Match) {
        return createErrorResponse(
          400,
          "Invalid request: expected DELETE /<sha256> format",
        );
      }

      try {
        return await handleDeleteRequest(req, sha256Match[1]!, server);
      } catch (error) {
        console.error("Error handling delete request:", error);
        return createErrorResponse(
          500,
          `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    // Handle GET and HEAD requests
    if (req.method === "GET" || req.method === "HEAD") {
      const parsed = parseRequest(url);

      if (!parsed) {
        return createErrorResponse(
          400,
          "Invalid request: expected /<sha256>[.ext] format",
        );
      }

      try {
        return await handleBlobRequest(req, parsed);
      } catch (error) {
        console.error("Error handling request:", error);
        return createErrorResponse(
          500,
          `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    // Method not allowed
    return createErrorResponse(405, "Method not allowed");
  },
});

console.log(`Blossom proxy server running at ${server.url}`);
console.log(`Cache directory: ${CACHE_DIR}`);
console.log(`Download workers: ${DOWNLOAD_WORKERS}`);

// Graceful shutdown handler
const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.stop();

  await terminateDownloadWorkerPool();

  // Give existing requests time to complete
  // Bun's server.stop() already handles this, but we can add a small delay
  // to ensure in-flight requests finish
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("Server stopped gracefully");
  process.exit(0);
};

// Handle termination signals
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
