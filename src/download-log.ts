const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_COLORS = [
  "\x1b[38;5;39m",
  "\x1b[38;5;45m",
  "\x1b[38;5;50m",
  "\x1b[38;5;75m",
  "\x1b[38;5;81m",
  "\x1b[38;5;113m",
  "\x1b[38;5;149m",
  "\x1b[38;5;178m",
  "\x1b[38;5;208m",
  "\x1b[38;5;203m",
  "\x1b[38;5;198m",
  "\x1b[38;5;141m",
];

function useColor(): boolean {
  return Boolean(process.stdout?.isTTY);
}

function pickColor(hash: string): string {
  let sum = 0;
  for (let index = 0; index < hash.length; index += 1) {
    sum = (sum + hash.charCodeAt(index)) % ANSI_COLORS.length;
  }

  return ANSI_COLORS[sum] ?? ANSI_COLORS[0]!;
}

export function shortHash(hash: string, length: number = 8): string {
  return hash.slice(0, length).toLowerCase();
}

export function formatDownloadLabel(hash: string): string {
  const value = shortHash(hash);
  if (!useColor()) {
    return `[${value}]`;
  }

  return `${pickColor(hash)}[${value}]${ANSI_RESET}`;
}

export function formatDurationMs(startTime: number): string {
  const elapsed = Math.max(0, performance.now() - startTime);
  return `${elapsed.toFixed(elapsed >= 100 ? 0 : 1)}ms`;
}

export function formatDim(text: string): string {
  if (!useColor()) {
    return text;
  }

  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

export function logDownload(
  hash: string,
  message: string,
  ...args: unknown[]
): void {
  console.log(`${formatDownloadLabel(hash)} ${message}`, ...args);
}

export function warnDownload(
  hash: string,
  message: string,
  ...args: unknown[]
): void {
  console.warn(`${formatDownloadLabel(hash)} ${message}`, ...args);
}

export function errorDownload(
  hash: string,
  message: string,
  ...args: unknown[]
): void {
  console.error(`${formatDownloadLabel(hash)} ${message}`, ...args);
}
