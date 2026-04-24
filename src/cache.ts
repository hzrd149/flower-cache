// Cache management functions

import { Database } from "bun:sqlite";
import { unlink, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BunFile } from "bun";
import {
  buildCacheFilename,
  buildCachePath,
  inferExtensionFromFile,
  normalizeCacheExtension,
  parseCacheFilename,
} from "./cache-file";
import { CACHE_DIR, MAX_CACHE_SIZE } from "./config";

interface CacheMetadataRow {
  sha256: string;
  size: number;
  uploaded: number | null;
  extension: string | null;
}

export interface CacheEntry {
  sha256: string;
  extension: string;
  filename: string;
  filePath: string;
}

/**
 * Ensure the cache directory exists
 */
export async function ensureCacheDir(): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {
    // Directory might already exist, ignore
  }
}

/**
 * Initialize cache system (directory and database)
 * Should be called on application startup
 */
export async function initializeCache(): Promise<void> {
  await ensureCacheDir();

  const dbPath = getMetadataDbPath();
  const dbExists = await Bun.file(dbPath).exists();

  try {
    const database = initDatabase();

    if (!dbExists) {
      console.log("Cache metadata database not found, initializing...");
    }

    const migrationResult = await migrateCacheFiles();

    if (!dbExists || migrationResult.changed || metadataRebuildRequired) {
      await rebuildDatabase();
      metadataRebuildRequired = false;
    } else {
      try {
        const countQuery = database.query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM cache_metadata",
        );
        countQuery.get();
      } catch (error) {
        console.warn("Database schema issue detected, rebuilding...", error);
        await rebuildDatabase();
      }
    }

    const cacheSize = await getCacheSize();
    const countQuery = database.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM cache_metadata",
    );
    const countRow = countQuery.get();
    const fileCount = countRow ? countRow.count : 0;

    console.log(
      `Cache initialized: ${fileCount} files, ${(cacheSize / 1024 / 1024).toFixed(2)} MB`,
    );
    if (migrationResult.renamed > 0) {
      console.log(
        `Cache filename migration renamed ${migrationResult.renamed} files`,
      );
    }
    if (MAX_CACHE_SIZE !== null) {
      console.log(
        `Cache size limit: ${(MAX_CACHE_SIZE / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  } catch (error) {
    console.error("Failed to initialize cache database:", error);
  }
}

/**
 * Get the metadata database path
 */
function getMetadataDbPath(): string {
  return `${CACHE_DIR}/.cache-metadata.db`;
}

let db: Database | null = null;
let dbInitialized = false;
let metadataRebuildRequired = false;

function initDatabase(): Database {
  if (db && dbInitialized) {
    return db;
  }

  db = new Database(getMetadataDbPath());
  db.exec("PRAGMA journal_mode=WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_metadata (
      sha256 TEXT PRIMARY KEY,
      last_accessed INTEGER NOT NULL,
      size INTEGER NOT NULL,
      uploaded INTEGER,
      extension TEXT NOT NULL DEFAULT '.bin'
    );
  `);

  try {
    const tableInfo = db
      .query("PRAGMA table_info(cache_metadata)")
      .all() as Array<{
      name: string;
    }>;
    const hasUploadedColumn = tableInfo.some((row) => row.name === "uploaded");
    const hasExtensionColumn = tableInfo.some(
      (row) => row.name === "extension",
    );

    if (!hasUploadedColumn) {
      console.log("Migrating cache metadata: adding uploaded column...");
      db.exec("ALTER TABLE cache_metadata ADD COLUMN uploaded INTEGER");
      const currentTimestamp = Math.floor(Date.now() / 1000);
      db.exec(
        `UPDATE cache_metadata SET uploaded = ${currentTimestamp} WHERE uploaded IS NULL`,
      );
      metadataRebuildRequired = true;
    }

    if (!hasExtensionColumn) {
      console.log("Migrating cache metadata: adding extension column...");
      db.exec("ALTER TABLE cache_metadata ADD COLUMN extension TEXT");
      db.exec(
        "UPDATE cache_metadata SET extension = '.bin' WHERE extension IS NULL",
      );
      metadataRebuildRequired = true;
    }
  } catch (error) {
    console.warn(
      "Migration check failed (this is usually safe to ignore):",
      error,
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_last_accessed
    ON cache_metadata(last_accessed);
  `);

  dbInitialized = true;
  return db;
}

async function rebuildDatabase(): Promise<void> {
  console.log("Rebuilding cache metadata database from directory scan...");
  const database = initDatabase();

  try {
    database.exec("BEGIN TRANSACTION");
    database.exec("DELETE FROM cache_metadata");

    const files = await readdir(CACHE_DIR);
    let rebuilt = 0;

    for (const filename of files) {
      if (filename.startsWith(".")) {
        continue;
      }

      const parsed = parseCacheFilename(filename);
      if (!parsed) {
        console.warn(`Skipping unrecognized cache file ${filename}`);
        continue;
      }

      const extension = normalizeCacheExtension(parsed.extension);
      const filePath = join(CACHE_DIR, filename);

      try {
        const stats = await stat(filePath);
        const uploadedTimestamp = Math.floor(stats.mtimeMs / 1000);
        const stmt = database.prepare(
          `INSERT OR REPLACE INTO cache_metadata (
             sha256,
             last_accessed,
             size,
             uploaded,
             extension
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        stmt.run(
          parsed.sha256,
          stats.mtimeMs,
          stats.size,
          uploadedTimestamp,
          extension,
        );
        rebuilt += 1;
      } catch (error) {
        console.warn(`Skipping file ${filename} during rebuild:`, error);
      }
    }

    database.exec("COMMIT");
    console.log(`Rebuilt metadata for ${rebuilt} cache files`);
  } catch (error) {
    database.exec("ROLLBACK");
    console.error("Error rebuilding database:", error);
    throw error;
  }
}

async function ensureDatabase(): Promise<Database> {
  try {
    return initDatabase();
  } catch (error) {
    console.warn("Database initialization failed, attempting rebuild:", error);
    await rebuildDatabase();
    return initDatabase();
  }
}

async function persistCacheMetadata(
  sha256: string,
  size: number,
  uploadedTimestamp: number | null,
  extension: string,
  lastAccessed = Date.now(),
): Promise<void> {
  const database = await ensureDatabase();
  const stmt = database.prepare(
    `INSERT OR REPLACE INTO cache_metadata (
       sha256,
       last_accessed,
       size,
       uploaded,
       extension
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run(
    sha256,
    lastAccessed,
    size,
    uploadedTimestamp,
    normalizeCacheExtension(extension),
  );
}

async function getMetadataRow(
  sha256: string,
): Promise<CacheMetadataRow | null> {
  try {
    const database = await ensureDatabase();
    const stmt = database.prepare<CacheMetadataRow, [string]>(
      "SELECT sha256, size, uploaded, extension FROM cache_metadata WHERE sha256 = ?",
    );
    return stmt.get(sha256) ?? null;
  } catch {
    return null;
  }
}

async function findCacheEntryOnDisk(
  sha256: string,
): Promise<CacheEntry | null> {
  try {
    const files = await readdir(CACHE_DIR);

    for (const filename of files) {
      if (filename.startsWith(".")) {
        continue;
      }

      const parsed = parseCacheFilename(filename);
      if (!parsed || parsed.sha256 !== sha256) {
        continue;
      }

      const extension = normalizeCacheExtension(parsed.extension);
      return {
        sha256,
        extension,
        filename,
        filePath: join(CACHE_DIR, filename),
      };
    }
  } catch {
    // ignore disk lookup failures
  }

  return null;
}

export async function findCacheEntry(
  sha256: string,
): Promise<CacheEntry | null> {
  const normalizedSha = sha256.toLowerCase();
  const row = await getMetadataRow(normalizedSha);

  if (row) {
    const extension = normalizeCacheExtension(row.extension);
    const filePath = buildCachePath(normalizedSha, extension);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return {
        sha256: normalizedSha,
        extension,
        filename: buildCacheFilename(normalizedSha, extension),
        filePath,
      };
    }
  }

  const diskEntry = await findCacheEntryOnDisk(normalizedSha);
  if (!diskEntry) {
    return null;
  }

  try {
    const stats = await Bun.file(diskEntry.filePath).stat();
    await persistCacheMetadata(
      normalizedSha,
      stats.size,
      row?.uploaded ?? Math.floor(stats.mtimeMs / 1000),
      diskEntry.extension,
      Date.now(),
    );
  } catch {
    // ignore metadata repair failures
  }

  return diskEntry;
}

async function migrateCacheFiles(): Promise<{
  changed: boolean;
  renamed: number;
}> {
  const files = await readdir(CACHE_DIR);
  let renamedCount = 0;

  for (const filename of files) {
    if (filename.startsWith(".")) {
      continue;
    }

    const parsed = parseCacheFilename(filename);
    if (!parsed) {
      console.warn(`Skipping unrecognized cache file ${filename}`);
      continue;
    }

    const sourcePath = join(CACHE_DIR, filename);
    let extension = parsed.extension;

    if (!extension) {
      extension = await inferExtensionFromFile(sourcePath);
    }

    const targetFilename = buildCacheFilename(parsed.sha256, extension);
    if (filename === targetFilename) {
      continue;
    }

    const targetPath = join(CACHE_DIR, targetFilename);
    try {
      const targetExists = await Bun.file(targetPath).exists();
      if (targetExists) {
        await unlink(sourcePath);
      } else {
        await rename(sourcePath, targetPath);
      }
      renamedCount += 1;
    } catch (error) {
      console.warn(`Failed to migrate cache file ${filename}:`, error);
    }
  }

  return { changed: renamedCount > 0, renamed: renamedCount };
}

/**
 * Update access time for a cached blob
 * @param sha256 - The SHA256 hash of the blob
 * @param size - The size of the blob in bytes (optional, will try database first, then file stats if needed)
 */
export async function updateAccessTime(
  sha256: string,
  size?: number,
): Promise<void> {
  try {
    const normalizedSha = sha256.toLowerCase();
    const row = await getMetadataRow(normalizedSha);
    const entry = await findCacheEntry(normalizedSha);

    if (!entry) {
      return;
    }

    if (size === undefined) {
      size = row?.size;
    }

    if (size === undefined) {
      size = (await Bun.file(entry.filePath).stat()).size;
    }

    if (size === undefined) {
      return;
    }

    await persistCacheMetadata(
      normalizedSha,
      size,
      row?.uploaded ?? null,
      entry.extension,
      Date.now(),
    );
  } catch (error) {
    console.warn(`Failed to update access time for ${sha256}:`, error);
  }
}

/**
 * Check if a blob exists in cache
 * @returns BunFile if exists, null otherwise
 */
export async function checkCache(sha256: string): Promise<BunFile | null> {
  try {
    const entry = await findCacheEntry(sha256);
    if (!entry) {
      return null;
    }

    updateAccessTime(entry.sha256).catch((error) => {
      console.warn("Failed to update access time:", error);
    });

    return Bun.file(entry.filePath);
  } catch {
    return null;
  }
}

/**
 * Get total cache size in bytes
 */
export async function getCacheSize(): Promise<number> {
  try {
    const database = await ensureDatabase();
    const query = database.query<{ total: number }, []>(
      "SELECT COALESCE(SUM(size), 0) as total FROM cache_metadata",
    );
    const row = query.get();
    return row ? row.total : 0;
  } catch (error) {
    console.warn("Failed to get cache size:", error);
    return 0;
  }
}

/**
 * Get cache statistics (blob count and total size)
 * @returns Object with blobCount and totalSize (in bytes)
 */
export async function getCacheStats(): Promise<{
  blobCount: number;
  totalSize: number;
}> {
  try {
    const database = await ensureDatabase();
    const countQuery = database.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM cache_metadata",
    );
    const countRow = countQuery.get();
    const blobCount = countRow ? countRow.count : 0;
    const totalSize = await getCacheSize();
    return { blobCount, totalSize };
  } catch (error) {
    console.warn("Failed to get cache stats:", error);
    return { blobCount: 0, totalSize: 0 };
  }
}

/**
 * Prune cache by removing least-recently-used blobs
 * @returns Number of files pruned
 */
export async function pruneCache(): Promise<number> {
  if (MAX_CACHE_SIZE === null) {
    return 0;
  }

  try {
    const database = await ensureDatabase();
    const currentSize = await getCacheSize();

    if (currentSize <= MAX_CACHE_SIZE) {
      return 0;
    }

    const targetSize = Math.floor(MAX_CACHE_SIZE * 0.9);
    const sizeToFree = currentSize - targetSize;

    if (sizeToFree <= 0) {
      return 0;
    }

    console.log(
      `Cache size ${currentSize} exceeds limit ${MAX_CACHE_SIZE}, pruning...`,
    );

    const query = database.query<
      {
        sha256: string;
        size: number;
      },
      []
    >("SELECT sha256, size FROM cache_metadata ORDER BY last_accessed ASC");

    const rows = query.all();
    let freedSize = 0;
    let prunedCount = 0;

    for (const row of rows) {
      if (freedSize >= sizeToFree) {
        break;
      }

      const entry = await findCacheEntry(row.sha256);
      try {
        if (entry) {
          await Bun.file(entry.filePath).delete();
        }

        const deleteStmt = database.prepare(
          "DELETE FROM cache_metadata WHERE sha256 = ?",
        );
        deleteStmt.run(row.sha256);

        freedSize += row.size;
        prunedCount += 1;
      } catch (error) {
        console.warn(`Failed to prune file ${row.sha256}:`, error);
        try {
          const deleteStmt = database.prepare(
            "DELETE FROM cache_metadata WHERE sha256 = ?",
          );
          deleteStmt.run(row.sha256);
        } catch {
          // Ignore database errors
        }
      }
    }

    console.log(
      `Pruned ${prunedCount} files, freed ${freedSize} bytes (${(freedSize / 1024 / 1024).toFixed(2)} MB)`,
    );

    return prunedCount;
  } catch (error) {
    console.error("Pruning failed:", error);
    return 0;
  }
}

/**
 * Check if pruning is needed and prune if necessary
 * This is called asynchronously to avoid blocking requests
 */
export async function pruneCacheIfNeeded(): Promise<void> {
  if (MAX_CACHE_SIZE === null) {
    return;
  }

  try {
    const currentSize = await getCacheSize();
    if (currentSize > MAX_CACHE_SIZE) {
      await pruneCache();
    }
  } catch (error) {
    console.warn("Pruning check failed:", error);
  }
}

/**
 * Write a blob to cache
 */
export async function writeCache(
  sha256: string,
  data: Blob | ArrayBuffer,
  extension?: string,
): Promise<void> {
  const normalizedSha = sha256.toLowerCase();
  const normalizedExtension = normalizeCacheExtension(extension);
  const cachePath = buildCachePath(normalizedSha, normalizedExtension);
  await Bun.write(cachePath, data);

  const file = Bun.file(cachePath);
  const stats = await file.stat();
  const existing = await getMetadataRow(normalizedSha);
  await persistCacheMetadata(
    normalizedSha,
    stats.size,
    existing?.uploaded ?? Math.floor(Date.now() / 1000),
    normalizedExtension,
    Date.now(),
  );

  pruneCacheIfNeeded().catch((error) => {
    console.warn("Pruning check failed:", error);
  });
}

/**
 * Write a blob to cache with metadata (size and upload timestamp)
 * Used for uploads to track when blobs were uploaded
 */
export async function writeCacheWithMetadata(
  sha256: string,
  size: number,
  uploadedTimestamp: number,
  extension?: string,
): Promise<void> {
  try {
    await persistCacheMetadata(
      sha256.toLowerCase(),
      size,
      uploadedTimestamp,
      normalizeCacheExtension(extension),
    );

    pruneCacheIfNeeded().catch((error) => {
      console.warn("Pruning check failed:", error);
    });
  } catch (error) {
    console.warn(`Failed to write cache metadata for ${sha256}:`, error);
  }
}

/**
 * Get upload timestamp from database for a blob
 * @param sha256 - The SHA256 hash of the blob
 * @returns Upload timestamp (Unix timestamp in seconds) or null if not found
 */
export async function getUploadTimestampFromDb(
  sha256: string,
): Promise<number | null> {
  try {
    const row = await getMetadataRow(sha256.toLowerCase());
    return row?.uploaded ?? null;
  } catch (error) {
    console.warn(`Failed to get upload timestamp for ${sha256}:`, error);
    return null;
  }
}

export async function getCacheExtensionFromDb(
  sha256: string,
): Promise<string | null> {
  try {
    const row = await getMetadataRow(sha256.toLowerCase());
    return row ? normalizeCacheExtension(row.extension) : null;
  } catch (error) {
    console.warn(`Failed to get cache extension for ${sha256}:`, error);
    return null;
  }
}

/**
 * Delete a blob from cache (file and database entry)
 * @param sha256 - The SHA256 hash of the blob to delete
 * @returns true if blob was deleted, false if not found
 */
export async function deleteBlobFromCache(sha256: string): Promise<boolean> {
  const normalizedSha = sha256.toLowerCase();
  let fileDeleted = false;
  let dbDeleted = false;

  try {
    const entry = await findCacheEntry(normalizedSha);
    if (entry) {
      await Bun.file(entry.filePath).delete();
      fileDeleted = true;
    }
  } catch (error) {
    console.warn(`Failed to delete file ${sha256}:`, error);
  }

  try {
    const database = await ensureDatabase();
    const deleteStmt = database.prepare(
      "DELETE FROM cache_metadata WHERE sha256 = ?",
    );
    const result = deleteStmt.run(normalizedSha);
    dbDeleted = result.changes > 0;
  } catch (error) {
    console.warn(`Failed to delete metadata for ${sha256}:`, error);
  }

  return fileDeleted || dbDeleted;
}
