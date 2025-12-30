// Cache management functions

import { mkdir } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { CACHE_DIR, MAX_CACHE_SIZE } from "./config";
import type { BunFile } from "bun";

/**
 * Ensure the cache directory exists
 */
export async function ensureCacheDir(): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore
  }
}

/**
 * Initialize cache system (directory and database)
 * Should be called on application startup
 */
export async function initializeCache(): Promise<void> {
  // Ensure cache directory exists
  await ensureCacheDir();

  // Check if database exists
  const dbPath = getMetadataDbPath();
  const dbFile = Bun.file(dbPath);
  const dbExists = await dbFile.exists();

  try {
    // Initialize database
    const database = initDatabase();

    // If database didn't exist, rebuild from directory scan
    if (!dbExists) {
      console.log("Cache metadata database not found, initializing...");
      await rebuildDatabase();
    } else {
      // Verify database is accessible and has correct schema
      try {
        const countQuery = database.query(
          "SELECT COUNT(*) as count FROM cache_metadata",
        );
        countQuery.get();
      } catch (error) {
        console.warn("Database schema issue detected, rebuilding...", error);
        await rebuildDatabase();
      }
    }

    // Log cache statistics
    const cacheSize = await getCacheSize();
    const countQuery = database.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM cache_metadata",
    );
    const countRow = countQuery.get();
    const fileCount = countRow ? countRow.count : 0;

    console.log(
      `Cache initialized: ${fileCount} files, ${(cacheSize / 1024 / 1024).toFixed(2)} MB`,
    );
    if (MAX_CACHE_SIZE !== null) {
      console.log(
        `Cache size limit: ${(MAX_CACHE_SIZE / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  } catch (error) {
    console.error("Failed to initialize cache database:", error);
    // Don't throw - allow server to start even if metadata tracking fails
    // Cache will still work, just without pruning
  }
}

/**
 * Get the cache file path for a given sha256 hash
 */
function getCachePath(sha256: string): string {
  return `${CACHE_DIR}/${sha256}`;
}

/**
 * Get the metadata database path
 */
function getMetadataDbPath(): string {
  return `${CACHE_DIR}/.cache-metadata.db`;
}

// Initialize SQLite database
let db: Database | null = null;
let dbInitialized = false;

/**
 * Initialize the SQLite database for cache metadata
 */
function initDatabase(): Database {
  if (db && dbInitialized) {
    return db;
  }

  const dbPath = getMetadataDbPath();
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.exec("PRAGMA journal_mode=WAL");

  // Create table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_metadata (
      sha256 TEXT PRIMARY KEY,
      last_accessed INTEGER NOT NULL,
      size INTEGER NOT NULL,
      uploaded INTEGER
    );
  `);

  // Migrate existing databases: add uploaded column if it doesn't exist
  try {
    const tableInfo = db.query("PRAGMA table_info(cache_metadata)").all();
    const hasUploadedColumn = tableInfo.some(
      (row: any) => row.name === "uploaded",
    );
    if (!hasUploadedColumn) {
      console.log("Migrating cache metadata: adding uploaded column...");
      db.exec("ALTER TABLE cache_metadata ADD COLUMN uploaded INTEGER");
      // Set uploaded timestamp for existing rows to current time as fallback
      const currentTimestamp = Math.floor(Date.now() / 1000);
      db.exec(
        `UPDATE cache_metadata SET uploaded = ${currentTimestamp} WHERE uploaded IS NULL`,
      );
      console.log("Migration complete: added uploaded column");
    }
  } catch (error) {
    // Migration might fail if column already exists, ignore
    console.warn("Migration check failed (this is usually safe to ignore):", error);
  }

  // Create index for efficient LRU queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_last_accessed
    ON cache_metadata(last_accessed);
  `);

  dbInitialized = true;
  return db;
}

/**
 * Rebuild database from cache directory scan
 * Used when database is missing or corrupted
 */
async function rebuildDatabase(): Promise<void> {
  console.log("Rebuilding cache metadata database from directory scan...");
  const database = initDatabase();

  try {
    // Start transaction for better performance
    database.exec("BEGIN TRANSACTION");

    // Clear existing data
    database.exec("DELETE FROM cache_metadata");

    // Scan cache directory
    const files = await readdir(CACHE_DIR);
    let rebuilt = 0;

    for (const filename of files) {
      // Skip hidden files (like .cache-metadata.db)
      if (filename.startsWith(".")) continue;

      // Use filename as sha256
      const sha256 = filename;
      const filePath = getCachePath(sha256);

      try {
        const stats = await stat(filePath);
        const lastAccessed = stats.mtimeMs; // Use mtime as fallback

        // Use mtime as fallback for uploaded timestamp
        const uploadedTimestamp = Math.floor(stats.mtimeMs / 1000);
        const stmt = database.prepare(
          `INSERT OR REPLACE INTO cache_metadata (sha256, last_accessed, size, uploaded)
           VALUES (?, ?, ?, ?)`,
        );
        stmt.run(sha256, lastAccessed, stats.size, uploadedTimestamp);
        rebuilt++;
      } catch (error) {
        // Skip files that can't be accessed
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

/**
 * Ensure database is initialized and valid
 */
async function ensureDatabase(): Promise<Database> {
  try {
    return initDatabase();
  } catch (error) {
    console.warn("Database initialization failed, attempting rebuild:", error);
    try {
      await rebuildDatabase();
      return initDatabase();
    } catch (rebuildError) {
      console.error("Database rebuild failed:", rebuildError);
      throw rebuildError;
    }
  }
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
    const database = await ensureDatabase();
    const now = Date.now();

    // If size not provided, try to get it from database first
    if (size === undefined) {
      const sizeStmt = database.prepare<{ size: number }, [string]>(
        "SELECT size FROM cache_metadata WHERE sha256 = ?",
      );
      const existing = sizeStmt.get(sha256);
      if (existing) {
        size = existing.size;
      } else {
        // Not in database, get from file stats
        try {
          const file = Bun.file(getCachePath(sha256));
          const exists = await file.exists();
          if (!exists) {
            // File doesn't exist, nothing to do (might not be in DB yet)
            return;
          }
          const stats = await file.stat();
          size = stats.size;
        } catch {
          // File access failed, nothing to do
          return;
        }
      }
    }

    // Get existing uploaded timestamp to preserve it
    const existingStmt = database.prepare<{ uploaded: number | null }, [string]>(
      "SELECT uploaded FROM cache_metadata WHERE sha256 = ?",
    );
    const existing = existingStmt.get(sha256);
    const uploadedTimestamp = existing?.uploaded ?? null;

    // Upsert access time and size, preserving uploaded timestamp
    const stmt = database.prepare(
      `INSERT OR REPLACE INTO cache_metadata (sha256, last_accessed, size, uploaded)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.run(sha256, now, size, uploadedTimestamp);
  } catch (error) {
    // Don't fail the request if metadata update fails
    console.warn(`Failed to update access time for ${sha256}:`, error);
  }
}

/**
 * Check if a blob exists in cache
 * @returns BunFile if exists, null otherwise
 */
export async function checkCache(sha256: string): Promise<BunFile | null> {
  const cachePath = getCachePath(sha256);
  try {
    const file = Bun.file(cachePath);
    const exists = await file.exists();
    if (exists) {
      // Update access time asynchronously (don't await to avoid blocking)
      // No need to call stat() - updateAccessTime will get size from database or file if needed
      updateAccessTime(sha256).catch((error) => {
        console.warn(`Failed to update access time:`, error);
      });
      return file;
    }
    return null;
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
 * Prune cache by removing least-recently-used blobs
 * @returns Number of files pruned
 */
export async function pruneCache(): Promise<number> {
  if (MAX_CACHE_SIZE === null) {
    return 0; // No size limit configured
  }

  try {
    const database = await ensureDatabase();
    const currentSize = await getCacheSize();

    if (currentSize <= MAX_CACHE_SIZE) {
      return 0; // Cache is within limits
    }

    // Calculate target size (90% of max to leave headroom)
    const targetSize = Math.floor(MAX_CACHE_SIZE * 0.9);
    const sizeToFree = currentSize - targetSize;

    if (sizeToFree <= 0) {
      return 0;
    }

    console.log(
      `Cache size ${currentSize} exceeds limit ${MAX_CACHE_SIZE}, pruning...`,
    );

    // Get least-recently-used blobs ordered by last_accessed
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

      const sha256 = row.sha256;
      const fileSize = row.size;
      const cachePath = getCachePath(sha256);

      try {
        // Delete file from disk
        const file = Bun.file(cachePath);
        await file.delete();

        // Remove from database
        const deleteStmt = database.prepare(
          "DELETE FROM cache_metadata WHERE sha256 = ?",
        );
        deleteStmt.run(sha256);

        freedSize += fileSize;
        prunedCount++;
      } catch (error) {
        console.warn(`Failed to prune file ${sha256}:`, error);
        // Remove from database even if file deletion fails
        try {
          const deleteStmt = database.prepare(
            "DELETE FROM cache_metadata WHERE sha256 = ?",
          );
          deleteStmt.run(sha256);
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
    return; // No size limit configured
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
): Promise<void> {
  const cachePath = getCachePath(sha256);
  await Bun.write(cachePath, data);

  // Trigger pruning check (don't await to avoid blocking)
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
): Promise<void> {
  try {
    const database = await ensureDatabase();
    const now = Date.now();

    const stmt = database.prepare(
      `INSERT OR REPLACE INTO cache_metadata (sha256, last_accessed, size, uploaded)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.run(sha256, now, size, uploadedTimestamp);

    // Trigger pruning check (don't await to avoid blocking)
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
    const database = await ensureDatabase();
    const stmt = database.prepare<{ uploaded: number | null }, [string]>(
      "SELECT uploaded FROM cache_metadata WHERE sha256 = ?",
    );
    const result = stmt.get(sha256);
    return result?.uploaded ?? null;
  } catch (error) {
    console.warn(`Failed to get upload timestamp for ${sha256}:`, error);
    return null;
  }
}

/**
 * Delete a blob from cache (file and database entry)
 * @param sha256 - The SHA256 hash of the blob to delete
 * @returns true if blob was deleted, false if not found
 */
export async function deleteBlobFromCache(sha256: string): Promise<boolean> {
  const cachePath = getCachePath(sha256);
  let fileDeleted = false;
  let dbDeleted = false;

  try {
    // Delete file from disk
    const file = Bun.file(cachePath);
    const exists = await file.exists();
    if (exists) {
      await file.delete();
      fileDeleted = true;
    }
  } catch (error) {
    console.warn(`Failed to delete file ${sha256}:`, error);
  }

  try {
    // Delete from database
    const database = await ensureDatabase();
    const deleteStmt = database.prepare(
      "DELETE FROM cache_metadata WHERE sha256 = ?",
    );
    const result = deleteStmt.run(sha256);
    dbDeleted = result.changes > 0;
  } catch (error) {
    console.warn(`Failed to delete metadata for ${sha256}:`, error);
  }

  return fileDeleted || dbDeleted;
}
