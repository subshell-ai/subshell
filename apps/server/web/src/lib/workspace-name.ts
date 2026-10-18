/** The locale stamp a fresh workspace's default name carries. */
function stamp(date: Date): string {
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Placeholder name for a fresh workspace, e.g. `Aug 28, 4:45 PM`. Named in-place inside the workspace afterwards. */
export function defaultWorkspaceName(): string {
  return stamp(new Date());
}

/**
 * `base`, made unique against `existing` by appending ` (2)`, ` (3)`, …
 *
 * A fresh workspace's default name is a stamp that only reaches MINUTES, so a
 * back-to-back create sends the identical name twice. Names stopped being
 * unique with migration 0058 — nothing 409s anymore — but two tree branches
 * reading the same is confusion, so the dialog still de-dupes the placeholder
 * against the names the caller already holds. The person renames it in place;
 * the suffix only rides on the rare back-to-back create.
 */
export function uniqueWorkspaceName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}
