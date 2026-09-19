import { relativeElapsed } from "@/components/subshell-status";

/**
 * "checked 2m ago" for a detection stamp, or null when there is none.
 *
 * Absent is not an error. A node running a node CLI older than the field simply
 * has nothing to say, and a surface must render that as silence rather than as
 * "checked never", which would read as a failure.
 *
 * `relativeElapsed` answers "just now" under a minute and a bare "2m" / "3h"
 * above it, so the suffix cannot be unconditional or a fresh scan reads
 * "checked just now ago".
 * @param checkedAt - ISO 8601 stamp from a harness entry, or undefined
 */
export function checkedAtLabel(checkedAt: string | undefined): string | null {
  if (!checkedAt) return null;
  if (!Number.isFinite(Date.parse(checkedAt))) return null;
  const elapsed = relativeElapsed(checkedAt);
  return elapsed === "just now" ? "checked just now" : `checked ${elapsed} ago`;
}
