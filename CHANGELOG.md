# Changelog

## 0.8.0 - 2026-09-03

- Stream cache misses to the client while they download. Time-to-first-byte on a miss was previously the length of the entire upstream transfer: the body was read into a temp file in a download worker, hashed, verified and renamed, and only then did the handler re-open it from disk to answer. A blob above `STREAM_THROUGH_MIN_SIZE` (default 2MB) is now relayed to the client as it arrives — measured against a slow 8MB upstream, first byte dropped from 1.37s to 0.35s, and to 0.016s when the upstream declares a `Content-Length`. Set `STREAM_THROUGH=false` to restore store-and-forward.
- Keep downloads in the worker pool while streaming, so the `DOWNLOAD_BUDGET`, stall, throughput and worker self-healing guards are unchanged. Chunks cross to the main thread as transferable buffers under a credit window (`STREAM_CHUNK_CREDITS`), so a client reading slower than the upstream sends cannot grow memory without bound.
- Only commit verified blobs to the cache, as before: a streamed body is sent before its hash is known, and if it turns out wrong the client keeps what it received, a warning is logged and nothing is cached. Below the threshold the download-verify-serve path still runs, so small blobs keep both verification-before-send and failover to another server. An upstream that declares no `Content-Length` is measured as it arrives rather than assumed large, so the threshold behaves the same whether or not a size is declared.
- Fix `addCorsHeaders` rebuilding every response as `new Response(response.body)`, which re-wrapped a `BunFile` body as a generic stream. This dropped `Content-Length` — every blob response fell back to chunked encoding — and lost a slice's end bound, so a `Range: bytes=100-199` request against an 8MB cached blob was answered with everything from byte 100 to the end of the file.
- Answer a request whose shared download was interrupted with `503 Retry-After` rather than a `404`, so a cancelled or lost transfer no longer records a false miss for everyone else waiting on it.
- Remove `src/stream-utils.ts`, `src/hash-stream.ts` and `src/cache-stream.ts`, an earlier tee-based version of this idea left unreferenced since the worker pool landed. Its `createCacheStream` wrote unverified bytes straight to the final cache path.

## 0.7.1 - 2026-08-12

- Bound upstream body transfers with `DOWNLOAD_STALL_TIMEOUT`, `DOWNLOAD_MIN_SPEED`, and `DOWNLOAD_MAX_DURATION`. Nothing previously limited the body read once response headers arrived, so an upstream reached via `xs` that answered `200` and then trickled could pin a download worker indefinitely and starve the pool for every other request.
- Replace download workers that crash or stop responding, instead of letting the pool shrink toward zero and leave queued downloads permanently unanswered.
- Bound how long a download may wait for a free worker (`DOWNLOAD_QUEUE_TIMEOUT`, answered with `503`) and its total lifetime (`DOWNLOAD_JOB_TIMEOUT`, answered with `504`), so a request can no longer hang indefinitely.
- Add `REQUEST_IDLE_TIMEOUT` (default 120s). Bun's 10s default silently dropped the client connection on any cache miss that took longer to fetch, including the error responses above; the blob still cached, but the first requester never received it.
- Flush cached blob writes every 4 MiB so an upstream delivering faster than the disk can absorb no longer grows the write buffer without bound.

## 0.7.0 - 2026-07-29

- Add BUD-13 `PUT /<sha256>` path-based uploads with path-hash validation.
- Support BUD-13 remote source mirroring with repeated `url` query parameters.
- Support BUD-10-style mirroring from Blossom source hints via `xs`, `sx`, and `as` query parameters.
- Keep legacy BUD-02 `PUT /upload` compatibility.

## 0.6.0 - 2026-07-06

- Add a negative cache (`NEGATIVE_CACHE_TTL`) so repeated requests for a blob that is missing from all upstreams get an instant `404` instead of re-triggering a full upstream hunt every time the in-flight download resolves. Invalidated on upload.
- Bound the total time spent hunting a single blob across all candidate servers with `DOWNLOAD_BUDGET`, so a miss can no longer cost `REQUEST_TIMEOUT × (number of servers)`.
- Reject new downloads with `503 Retry-After` once `MAX_DOWNLOAD_QUEUE` jobs are queued, so a flood of distinct missing hashes can't grow the worker queue or upstream fan-out without bound.
- Lower the default per-server `REQUEST_TIMEOUT` from 30s to 10s.

## 0.5.0 - 2026-07-06

- Read BUD-10 server hints from the `xs` query parameter (spec-compliant), keeping `sx` as a legacy alias. Previously all server hints were silently ignored.
- `PUT /upload` now returns `201 Created` for newly stored blobs and `200 OK` when the blob already exists, per BUD-02.
- Validate the optional `X-SHA-256` request header on upload, responding with `409 Conflict` when it does not match the received content.
- Default blob descriptor URLs to a `.bin` extension when the type is unknown.
- Document that upload/delete are intentionally IP-gated instead of using BUD-11 Nostr authorization.

## 0.3.1 - 2026-03-21

- Simplify worker-side blob verification by hashing chunks directly in the download loop.
- Atomically promote validated temp files into cache with a rename instead of an extra file copy.

## 0.3.0 - 2026-03-21

- Move cache-miss blob downloads into a Bun worker pool so upstream fetch, hashing, and cache writes run off the main thread.
- Preserve main-thread request deduplication and cached-file serving while adding configurable download worker counts.
- Tighten download logging to focus on new blob downloads, verification outcomes, and elapsed request times.
