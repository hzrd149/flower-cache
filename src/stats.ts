import { getCacheStats } from "./cache";

/**
 * Format bytes into human-readable format (B, KB, MB, GB, TB)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]!}`;
}

/**
 * Generate HTML stats page
 */
export async function generateStatsPage(): Promise<string> {
  const stats = await getCacheStats();
  const formattedSize = formatBytes(stats.totalSize);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flower Cache Statistics</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
      max-width: 500px;
      width: 100%;
    }
    h1 {
      color: #333;
      margin-bottom: 30px;
      text-align: center;
      font-size: 28px;
      font-weight: 600;
    }
    .stats {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .stat-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    .stat-label {
      font-size: 16px;
      color: #666;
      font-weight: 500;
    }
    .stat-value {
      font-size: 24px;
      color: #333;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Flower Cache Statistics</h1>
    <div class="stats">
      <div class="stat-item">
        <span class="stat-label">Cached Blobs</span>
        <span class="stat-value">${stats.blobCount.toLocaleString()}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Total Cache Size</span>
        <span class="stat-value">${formattedSize}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

