/**
 * Which subshells show the pane diagnostics HUD on this device. The same
 * per-DEVICE tier as `sidebar-node-group-pref` and `terminal-font-size`: a
 * debugging overlay you opened on this screen is a property of the screen
 * you are at, not of the account.
 *
 * The set holds the TURNED-ON ids only, because off is the default: a
 * subshell nobody has diagnosed, and one enrolled after this preference was
 * written, both read off without needing a row. It also keeps the stored
 * value small.
 *
 * Keyed by subshell ID rather than by name, deliberately: a rename changes
 * every rendered surface and must change no stored preference.
 *
 * Every access is try/catch'd: private-mode Safari throws on `localStorage`
 * outright, and a terminal that cannot render because it could not read a
 * diagnostic preference is worse than a terminal that forgets one.
 */

/** JSON array of subshell ids whose diagnostics HUD is open on this device. */
const KEY = "subshell.paneDiagnostics";

/**
 * The turned-on set, or an empty array for absent/corrupt/blocked storage.
 *
 * A half-written or hand-edited value is filtered to the strings inside it
 * rather than thrown away wholesale, and a non-array parses to nothing,
 * never to an exception on every render.
 */
export function paneDiagnosticsIds(): string[] {
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
 * Persists the set.
 *
 * @param ids - the set as it should now be stored
 * @returns the same set, so callers bind their render to what was stored
 *          rather than to what they intended to store
 */
export function setPaneDiagnosticsIds(ids: readonly string[]): string[] {
  const next = [...ids];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the choice still holds for this page load, which is
    // the part the user is looking at.
  }
  return next;
}

/**
 * The set with one subshell's state flipped. Pure, so the caller decides
 * whether to persist it, so a test can exercise the rule without a storage
 * backend.
 */
export function togglePaneDiagnostics(ids: readonly string[], subshellId: string): string[] {
  return ids.includes(subshellId) ? ids.filter((id) => id !== subshellId) : [...ids, subshellId];
}
