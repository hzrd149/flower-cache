#!/usr/bin/env bun
import { PORT, CACHE_DIR } from "./src/config";
import { parseRequest } from "./src/parser";
import { handleBlobRequest } from "./src/handler";
import { handleUploadRequest } from "./src/upload";
import { handleDeleteRequest } from "./src/delete";
import { createErrorResponse } from "./src/response";
import { initializeCache } from "./src/cache";
import { generateStatsPage } from "./src/stats";

// Main server
const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
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

    // Handle GET / requests - serve stats page
    if (req.method === "GET" && url.pathname === "/") {
      try {
        const html = await generateStatsPage();
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      } catch (error) {
        console.error("Error generating stats page:", error);
        return createErrorResponse(
          500,
          `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
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

// Initialize cache system before starting server
await initializeCache();

console.log(`Blossom proxy server running at ${server.url}`);
console.log(`Cache directory: ${CACHE_DIR}`);

// Graceful shutdown handler
const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.stop();

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
