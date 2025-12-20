# flower-cache

A high-performance Blossom proxy server that caches blobs locally and proxies requests to upstream Blossom servers. Implements [BUD-01](https://github.com/nostr-protocol/nips/blob/master/83.md) and [BUD-10](https://github.com/nostr-protocol/nips/blob/master/83.md) URL schemas for decentralized blob storage and retrieval.

## Features

- **Local Caching**: Automatically caches downloaded blobs to disk for fast subsequent access
- **SHA-256 Validation**: Validates blob integrity before caching to ensure data integrity
- **ETag Support**: Implements HTTP ETags for efficient client-side caching (304 Not Modified responses)
- **Range Requests**: Supports HTTP range requests for partial content delivery (video streaming, resume downloads)
- **Multi-Server Proxying**: Tries multiple upstream servers in order until blob is found
- **CORS Support**: Full CORS headers for cross-origin requests
- **Author Server Resolution**: Stub for BUD-03 author server list resolution (ready for implementation)
- **High Performance**: Built with [Bun](https://bun.com) for maximum speed

## Installation

```bash
bun install
```

## Usage

Start the server:

```bash
bun run index.ts
```

The server will start on port 3000 (configurable in `src/config.ts`).

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
curl http://localhost:3000/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf

# With server hints
curl "http://localhost:3000/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?sx=cdn.example.com&sx=blossom.primal.net"

# With author pubkey
curl "http://localhost:3000/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?as=ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0"
```

### HEAD /<sha256>[.ext][?as=<pubkey>&sx=<server>]

Check if a blob exists without downloading it.

**Example:**
```bash
curl -I http://localhost:3000/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf
```

### OPTIONS /*

CORS preflight requests are automatically handled.

## How It Works

1. **Request Parsing**: Extracts SHA-256 hash, file extension, and query parameters from URL
2. **Cache Check**: First checks local cache directory (`./cache/`) for the blob
3. **Server Proxying**: If not cached, tries upstream servers in this order:
   - Server hints from `sx` query parameter
   - Author servers (from `as` query parameter via BUD-03 resolution - stub for now)
4. **Hash Validation**: Validates downloaded blob matches requested SHA-256 hash
5. **Caching**: Stores validated blob in local cache for future requests
6. **Response**: Returns blob with proper headers (Content-Type, ETag, Cache-Control)

## Caching

### Local Cache

Blobs are cached in the `./cache/` directory using the SHA-256 hash as the filename (no extension). The cache directory is created automatically on first run.

### HTTP Caching

The server implements comprehensive HTTP caching:

- **ETag**: Every response includes an `ETag` header with the SHA-256 hash
- **Cache-Control**: `public, max-age=31536000, immutable` (1 year, immutable since content-addressed)
- **304 Not Modified**: Returns 304 when client sends matching `If-None-Match` header

### Range Requests

Supports HTTP range requests for efficient partial content delivery:

```bash
# Request bytes 0-1023
curl -H "Range: bytes=0-1023" http://localhost:3000/<sha256>.mp4

# Request from byte 1024 to end
curl -H "Range: bytes=1024-" http://localhost:3000/<sha256>.mp4
```

## Configuration

Edit `src/config.ts` to customize:

- `PORT`: Server port (default: 3000)
- `CACHE_DIR`: Cache directory path (default: `./cache`)
- `REQUEST_TIMEOUT`: Upstream request timeout in milliseconds (default: 30000)
- `MAX_REDIRECTS`: Maximum redirect following depth (default: 5)
- `MIME_TYPES`: File extension to MIME type mapping

## Using from Web Apps

web applications can use this proxy server to fetch blobs from any BUD-01 or BUD-10 source. The proxy handles server discovery, caching, and validation automatically.

### Transforming BUD-01 URLs

Convert BUD-01 URLs to use the proxy by extracting the server domain and adding it as the `sx` parameter:

```javascript
// Transform BUD-01 URL to proxy URL
function transformBud01Url(originalUrl, proxyBase = 'http://localhost:3000') {
  const url = new URL(originalUrl);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const sha256WithExt = pathParts[pathParts.length - 1]; // e.g., "abc123...def.pdf"

  // Extract server domain (remove protocol)
  const server = url.hostname;

  // Build proxy URL with sx parameter
  const proxyUrl = new URL(`/${sha256WithExt}`, proxyBase);
  proxyUrl.searchParams.append('sx', server);

  return proxyUrl.toString();
}

// Example usage
const originalUrl = 'https://cdn.example.com/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf';
const proxyUrl = transformBud01Url(originalUrl);
// Result: "http://localhost:3000/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?sx=cdn.example.com"
```

### Transforming BUD-10 URIs

Convert BUD-10 URIs (with `blossom:` scheme) to proxy URLs, preserving server hints and author pubkeys:

```javascript
// Transform BUD-10 URI to proxy URL
function transformBud10Uri(blossomUri, proxyBase = 'http://localhost:3000') {
  // Remove "blossom:" prefix and parse
  const uri = blossomUri.replace(/^blossom:/, '');
  const [pathPart, queryPart] = uri.split('?');

  // Build proxy URL
  const proxyUrl = new URL(`/${pathPart}`, proxyBase);

  if (queryPart) {
    const params = new URLSearchParams(queryPart);

    // Add sx parameters (server hints)
    params.getAll('xs').forEach(server => {
      // Remove protocol if present
      const cleanServer = server.replace(/^https?:\/\//, '');
      proxyUrl.searchParams.append('sx', cleanServer);
    });

    // Add as parameters (author pubkeys)
    params.getAll('as').forEach(pubkey => {
      proxyUrl.searchParams.append('as', pubkey);
    });
  }

  return proxyUrl.toString();
}

// Example usage
const blossomUri = 'blossom:b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?xs=cdn.example.com&as=ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0';
const proxyUrl = transformBud10Uri(blossomUri);
// Result: "http://localhost:3000/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.pdf?sx=cdn.example.com&as=ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0"
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

