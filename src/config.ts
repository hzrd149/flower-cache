// Configuration constants

export const CACHE_DIR = "./cache";
export const PORT = 3000;
export const REQUEST_TIMEOUT = 30000; // 30 seconds
export const MAX_REDIRECTS = 5;

// MIME type mapping for common file extensions
export const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
};

