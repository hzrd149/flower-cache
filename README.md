# flower-cache

A high-performance Blossom proxy server that caches blobs locally and proxies requests to upstream Blossom servers. Implements [BUD-01](https://github.com/nostr-protocol/nips/blob/master/83.md) and [BUD-10](https://github.com/nostr-protocol/nips/blob/master/83.md) URL schemas for decentralized blob storage and retrieval.

## Features

- **Streaming Responses**: Streams blob data to clients immediately as it arrives from upstream servers, reducing latency for large files
- **Incremental Hash Calculation**: Calculates SHA-256 hash incrementally while streaming, validating blob integrity without buffering
- **Streaming Cache Writes**: Writes blobs to cache incrementally as data arrives, minimizing memory usage
- **Request Deduplication**: Multiple concurrent requests for the same blob share a single upstream fetch, eliminating redundant network traffic
- **Local Caching**: Automatically caches downloaded blobs to disk for fast subsequent access
- **LRU Cache Pruning**: Automatically removes least-recently-used blobs when cache size limit is exceeded
- **SHA-256 Validation**: Validates blob integrity before caching to ensure data integrity
- **ETag Support**: Implements HTTP ETags for efficient client-side caching (304 Not Modified responses)
- **Range Requests**: Supports HTTP range requests for partial content delivery (video streaming, resume downloads)
- **Multi-Server Proxying**: Tries multiple upstream servers in order until blob is found
- **CORS Support**: Full CORS headers for cross-origin requests
- **Author Server Resolution**: BUD-03 author server list resolution for automatic server discovery
- **High Performance**: Built with [Bun](https://bun.com) for maximum speed

## Installation

```bash
bun install
```

## Usage

### Running with bunx (Quick Start)

Run directly from GitHub without cloning:

```bash
bunx https://github.com/hzrd149/flower-cache
```

The server will start on port 24242 (configurable via `PORT` environment variable). You can also set environment variables:

```bash
PORT=8080 FALLBACK_SERVERS="https://blossom.primal.net" bunx https://github.com/hzrd149/flower-cache
```

### Running with Bun

Start the server:

```bash
bun run index.ts
```

The server will start on port 24242 (configurable via `PORT` environment variable).

### Running with Docker

#### Using Docker Compose (Recommended)

The easiest way to run with Docker:

```bash
docker-compose up -d
```

The cache directory (`./cache`) will be persisted as a volume. You can customize configuration using environment variables in a `.env` file or by setting them before running:

```bash
FALLBACK_SERVERS="https://blossom.primal.net" docker-compose up -d
```

**Note:** The default port mapping is `24242:24242`. To use a different port, either modify the `ports` section in `docker-compose.yml` or use `docker run` directly (see below).

#### Using Docker directly

Build the image:

```bash
docker build -t flower-cache .
```

Run the container:

```bash
docker run -d \
  --name flower-cache \
  -p 24242:24242 \
  -v $(pwd)/cache:/cache \
  -e LOOKUP_RELAYS="wss://purplepag.es" \
  -e FALLBACK_SERVERS="https://blossom.primal.net" \
  --restart unless-stopped \
  ghcr.io/hzrd149/flower-cache:latest
```

## API Endpoints

### GET /<sha256>[.ext][?as=<pubkey>&sx=<server>]

Retrieve a blob by its SHA-256 hash.

**Parameters:**

- `sha256` (path): 64-character hexadecimal SHA-256 hash of the blob
- `.ext` (optional): File extension (e.g., `.pdf`, `.png`)
- `as` (query, optional): Author pubkey(s) for server discovery (can be repeated)
- `sx` (query, optional): Server hint(s) where blob may be available (can be repeated)

**Example:**

```bash
# Basic request
curl http://localhost:24242/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf

# With server hints
curl "http://localhost:24242/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?sx=cdn.example.com&sx=blossom.primal.net"

# With author pubkey
curl "http://localhost:24242/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?as=ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0"
```

### HEAD /<sha256>[.ext][?as=<pubkey>&sx=<server>]

Check if a blob exists without downloading it.

**Example:**

```bash
curl -I http://localhost:24242/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf
```

### OPTIONS /\*

CORS preflight requests are automatically handled.

## How It Works

1. **Request Parsing**: Extracts SHA-256 hash, file extension, and query parameters from URL
2. **Cache Check**: First checks local cache directory (`./cache/`) for the blob
3. **Request Deduplication**: If multiple requests arrive for the same uncached blob, they share a single upstream fetch
4. **Server Proxying**: If not cached, tries upstream servers in this order:
   - Server hints from `sx` query parameter
   - Author servers (from `as` query parameter via BUD-03 resolution)
   - Fallback servers (from `FALLBACK_SERVERS` environment variable, if configured)
5. **Streaming Processing**: As data arrives from upstream:
   - Streams data immediately to waiting clients
   - Calculates SHA-256 hash incrementally
   - Writes chunks to cache file as they arrive
6. **Hash Validation**: After stream completes, validates computed hash matches requested SHA-256 hash
7. **Cache Cleanup**: If hash validation fails, invalid cache file is automatically deleted
8. **Response**: Returns blob with proper headers (Content-Type, ETag, Cache-Control)

## Caching

### Local Cache

Blobs are cached in the `./cache/` directory using the SHA-256 hash as the filename (no extension). The cache directory is created automatically on first run.

The cache uses an SQLite database to track access times for each blob, enabling efficient Least-Recently-Used (LRU) pruning when a maximum cache size is configured. Access times are updated automatically on every cache hit, ensuring accurate tracking without relying on filesystem access times.

#### Cache Size Management

If `MAX_CACHE_SIZE` is configured, the cache will automatically prune least-recently-used blobs when the total cache size exceeds the limit. Pruning reduces the cache to 90% of the maximum size to provide headroom for new blobs.

**Example:**

- If `MAX_CACHE_SIZE=10GB` and the cache reaches 10GB, it will prune until it's at 9GB
- The oldest accessed blobs (by `last_accessed` timestamp) are removed first
- Pruning happens automatically after new blobs are written to cache

### HTTP Caching

The server implements comprehensive HTTP caching:

- **ETag**: Every response includes an `ETag` header with the SHA-256 hash
- **Cache-Control**: `public, max-age=31536000, immutable` (1 year, immutable since content-addressed)
- **304 Not Modified**: Returns 304 when client sends matching `If-None-Match` header

### Range Requests

Supports HTTP range requests for efficient partial content delivery:

```bash
# Request bytes 0-1023
curl -H "Range: bytes=0-1023" http://localhost:24242/<sha256>.mp4

# Request from byte 1024 to end
curl -H "Range: bytes=1024-" http://localhost:24242/<sha256>.mp4
```

## Configuration

All configuration can be done via environment variables. You can also edit `src/config.ts` directly, but environment variables take precedence.

### Environment Variables

| Variable                   | Description                                                                                                                 | Default                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `PORT`                     | Server port number                                                                                                          | `24242`                                             |
| `CACHE_DIR`                | Cache directory path where blobs are stored                                                                                 | `./cache`                                           |
| `MAX_CACHE_SIZE`           | Maximum cache size (e.g., `10GB`, `500MB`, `1TB`). When exceeded, least-recently-used blobs are pruned.                     | (no limit)                                          |
| `REQUEST_TIMEOUT`          | Upstream request timeout in milliseconds                                                                                    | `30000` (30s)                                       |
| `MAX_REDIRECTS`            | Maximum number of redirects to follow                                                                                       | `5`                                                 |
| `USER_SERVER_LIST_TIMEOUT` | Timeout for looking up user server lists from Nostr relays (BUD-03) in milliseconds                                         | `20000` (20s)                                       |
| `LOOKUP_RELAYS`            | Comma-separated list of Nostr relay URLs for author server lookup (BUD-03)                                                  | (empty)                                             |
| `FALLBACK_SERVERS`         | Comma-separated list of Blossom server URLs to try as last resort (must include protocol: http:// or https://)              | (empty)                                             |
| `ALLOWED_UPLOAD_IPS`       | Comma-separated list of allowed IP addresses and CIDR ranges for upload/delete endpoints (e.g., `192.168.0.0/24,127.0.0.1`) | `127.0.0.0/8,::1,::ffff:127.0.0.1` (localhost only) |

### Using Multiple Environment Variables

You can set multiple environment variables at once:

```bash
PORT=8080 CACHE_DIR="./my-cache" REQUEST_TIMEOUT=60000 FALLBACK_SERVERS="https://blossom.primal.net" bun run index.ts
```

Or use a `.env` file (Bun automatically loads `.env` files). See `.env.example` for a complete example:

```bash
# .env
PORT=8080
CACHE_DIR=./my-cache
MAX_CACHE_SIZE=10GB
REQUEST_TIMEOUT=60000
LOOKUP_RELAYS=wss://relay1.example.com,wss://relay2.example.com
FALLBACK_SERVERS=https://blossom.primal.net,https://cdn.example.com
ALLOWED_UPLOAD_IPS=192.168.0.0/24,127.0.0.1
```

## Using from Web Apps

web applications can use this proxy server to fetch blobs from any BUD-01 or BUD-10 source. The proxy handles server discovery, caching, and validation automatically.

### Transforming BUD-01 URLs

Convert BUD-01 URLs to use the proxy by extracting the server domain and adding it as the `sx` parameter:

```javascript
// Transform BUD-01 URL to proxy URL
function transformBud01Url(originalUrl, proxyBase = "http://localhost:24242") {
  const url = new URL(originalUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const sha256WithExt = pathParts[pathParts.length - 1]; // e.g., "abc123...def.pdf"

  // Extract server domain (remove protocol)
  const server = url.hostname;

  // Build proxy URL with sx parameter
  const proxyUrl = new URL(`/${sha256WithExt}`, proxyBase);
  proxyUrl.searchParams.append("sx", server);

  return proxyUrl.toString();
}

// Example usage
const originalUrl =
  "https://cdn.example.com/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf";
const proxyUrl = transformBud01Url(originalUrl);
// Result: "http://localhost:24242/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?sx=cdn.example.com"
```

### Transforming BUD-10 URIs

Convert BUD-10 URIs (with `blossom:` scheme) to proxy URLs, preserving server hints and author pubkeys:

```javascript
// Transform BUD-10 URI to proxy URL
function transformBud10Uri(blossomUri, proxyBase = "http://localhost:24242") {
  // Remove "blossom:" prefix and parse
  const uri = blossomUri.replace(/^blossom:/, "");
  const [pathPart, queryPart] = uri.split("?");

  // Build proxy URL
  const proxyUrl = new URL(`/${pathPart}`, proxyBase);

  if (queryPart) {
    const params = new URLSearchParams(queryPart);

    // Add sx parameters (server hints)
    params.getAll("xs").forEach((server) => {
      // Remove protocol if present
      const cleanServer = server.replace(/^https?:\/\//, "");
      proxyUrl.searchParams.append("sx", cleanServer);
    });

    // Add as parameters (author pubkeys)
    params.getAll("as").forEach((pubkey) => {
      proxyUrl.searchParams.append("as", pubkey);
    });
  }

  return proxyUrl.toString();
}

// Example usage
const blossomUri =
  "blossom:b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?xs=cdn.example.com&as=ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0";
const proxyUrl = transformBud10Uri(blossomUri);
// Result: "http://localhost:24242/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?sx=cdn.example.com&as=ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0"
```

## BUD-01 & BUD-10 Compliance

This server implements:

- **BUD-01**: Server requirements and blob retrieval
  - GET/HEAD endpoints with SHA-256 hash
  - Optional file extensions
  - CORS headers
  - Range request support
  - Error responses with X-Reason header

- **BUD-10**: Blossom URI schema support
  - `sx` parameter for server hints
  - `as` parameter for author pubkeys
  - Server discovery via multiple hints

## Error Responses

All error responses include an `X-Reason` header with a human-readable message:

- `400 Bad Request`: Invalid request format or hash mismatch
- `404 Not Found`: Blob not found in cache or upstream servers
- `405 Method Not Allowed`: Unsupported HTTP method
- `416 Range Not Satisfiable`: Invalid range request
- `500 Internal Server Error`: Server error

## License

MIT
