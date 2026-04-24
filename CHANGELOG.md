# Changelog

## 0.3.1 - 2026-03-21

- Simplify worker-side blob verification by hashing chunks directly in the download loop.
- Atomically promote validated temp files into cache with a rename instead of an extra file copy.

## 0.3.0 - 2026-03-21

- Move cache-miss blob downloads into a Bun worker pool so upstream fetch, hashing, and cache writes run off the main thread.
- Preserve main-thread request deduplication and cached-file serving while adding configurable download worker counts.
- Tighten download logging to focus on new blob downloads, verification outcomes, and elapsed request times.
