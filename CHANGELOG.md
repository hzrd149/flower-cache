# Changelog

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
