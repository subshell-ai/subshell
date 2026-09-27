/** The locale stamp both a fresh name and a draft's sidebar label share. */
function stamp(date: Date): string {
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Placeholder name for a fresh workspace, e.g. `Aug 28, 4:45 PM`. Named in-place inside the workspace afterwards. */
export function defaultWorkspaceName(): string {
  return stamp(new Date());
}

/**
 * Formats a stored `createdAt` (ISO) the way a default name looks, e.g.
 * `Aug 28, 4:45 PM` — so a draft row in the sidebar reads like its saved
 * siblings instead of a bare "Unsaved workspace" (operator ask 2026-09-27).
 * An unparseable stamp is shown raw rather than blanked.
 */
export function formatWorkspaceDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : stamp(date);
}

/**
 * `base`, made unique against `existing` by appending ` (2)`, ` (3)`, …
 *
 * A fresh workspace's default name is a stamp that only reaches MINUTES, and the
 * server enforces one name per owner for a saved (non-draft) workspace — so
 * creating two in the same minute sent the identical name and the second died a
 * 409 (operator report 2026-09-27). This de-dupes the placeholder against the
 * names the caller already holds, so the placeholder is always submittable;
 * the person still renames it in place, and the suffix only rides on the rare
 * back-to-back create.
 *
 * Comparison is exact — the same rule the create route applies — so a name the
 * server would NOT refuse is never needlessly suffixed.
 */
export function uniqueWorkspaceName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}
