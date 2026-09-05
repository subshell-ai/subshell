/** Binary units, because these are memory and file sizes, not disk marketing. */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/**
 * Human-readable byte size. Null in, em-dash out — the callers all render a
 * value that may be unknown (a database file that cannot be stat'd).
 *
 * @param bytes - the size, or null when unknown
 * @returns e.g. `"11.4 MiB"`, or `"—"`
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes never get a decimal point; everything else gets one.
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * Coarse duration for an uptime reading: the two largest non-zero units, which
 * is as much precision as "how long has this been up" ever needs.
 *
 * @param seconds - elapsed whole seconds
 * @returns e.g. `"3d 4h"`, `"12m 30s"`, `"just started"`
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return "just started";
  const parts: string[] = [];
  const units: [number, string][] = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  let rest = Math.floor(seconds);
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || parts.length > 0) parts.push(`${n}${label}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}
