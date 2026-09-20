/**
 * Which node groups are shut in this device's sidebar — the same per-DEVICE
 * tier as `trust-notice-prefs` and `terminal-font-size`: how tall you like the
 * rail is a property of the screen you are at, not of the account.
 *
 * The set holds the COLLAPSED ids only, because open is the default: a node
 * that has never been touched, and a node enrolled after this preference was
 * written, both read open without needing a row. It also means the stored
 * value stays small on a fleet.
 *
 * Keyed by node ID rather than by node name, deliberately. An admin renaming
 * a machine changes every rendered surface (AGENTS.md) and must change no
 * stored preference — a group you shut stays shut through a rename.
 *
 * Every access is try/catch'd: private-mode Safari throws on `localStorage`
 * outright, and a rail that cannot render because it could not read a
 * cosmetic preference is worse than a rail that forgets one.
 */

/** JSON array of node ids whose sidebar group is collapsed on this device. */
const KEY = "subshell.sidebarNodeGroups";

/**
 * The collapsed set, or an empty array for absent/corrupt/blocked storage.
 *
 * A half-written or hand-edited value is filtered to the strings inside it
 * rather than thrown away wholesale — and a non-array parses to nothing,
 * never to an exception on every render.
 */
export function collapsedNodeGroups(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Persists one group's state.
 *
 * @param collapsed - the set as it should now be stored
 * @returns the same set, so callers bind their render to what was stored
 *          rather than to what they intended to store
 */
export function setCollapsedNodeGroups(collapsed: readonly string[]): string[] {
  const next = [...collapsed];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the choice still holds for this page load, which is
    // the part the user is looking at.
  }
  return next;
}

/**
 * The set with one node's state flipped. Pure — the caller decides whether to
 * persist it, so a test can exercise the rule without a storage backend.
 */
export function toggleNodeGroup(collapsed: readonly string[], nodeId: string): string[] {
  return collapsed.includes(nodeId) ? collapsed.filter((id) => id !== nodeId) : [...collapsed, nodeId];
}
