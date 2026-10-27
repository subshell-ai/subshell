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
let lastWritten: string[] | undefined;
let writeRefused = false;

export function paneDiagnosticsIds(): string[] {
  // Once a write has been refused this page load, the attempted set IS the
  // device's answer: storage still reads back the stale value, and two surfaces
  // asking the same question (the workspace header's menu and the dock terminal
  // beside it) would diverge on it, one checked and one not.
  if (writeRefused && lastWritten !== undefined) return [...lastWritten];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return lastWritten ? [...lastWritten] : [];
  }
}

/**
 * Fired on `window` (and mirrored from the browser's own `storage` event)
 * whenever this device's set changes, so a surface that renders the HUD and
 * a surface that offers the toggle (the workspace header's menu beside the
 * dock's terminal) can be different components without either polling.
 */
const CHANGE_EVENT = "subshell:pane-diagnostics-change";

/**
 * Persists the set and tells every reader on this page.
 *
 * @param ids - the set as it should now be stored
 * @returns the same set, so callers bind their render to what was stored
 *          rather than to what they intended to store
 */
export function setPaneDiagnosticsIds(ids: readonly string[]): string[] {
  const next = [...ids];
  lastWritten = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused (private mode, quota): the choice still holds for this
    // page load, and `paneDiagnosticsIds` now answers from it so every
    // instance on the page agrees rather than half of them reading a stale
    // store they cannot write.
    writeRefused = true;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

/**
 * Drops the page-load memory of what was written. For tests only: the module
 * keeps one answer across a page load on purpose, and a suite that shares this
 * worker would otherwise read another file's refused write as its own state.
 * @internal
 */
export function resetPaneDiagnosticsPrefForTests(): void {
  lastWritten = undefined;
  writeRefused = false;
}

/**
 * Calls `onChange` when the set changes on THIS page (the toggle) or another
 * tab of this device (the browser's cross-tab `storage` event, which fires
 * only for real storage writes — so a refused private-mode write does not
 * echo a change nobody stored).
 *
 * @param onChange - the listener to notify
 * @returns an unsubscribe function
 */
export function subscribePaneDiagnostics(onChange: () => void): () => void {
  const handler = (): void => onChange();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/**
 * The set with one subshell's state flipped. Pure, so the caller decides
 * whether to persist it, so a test can exercise the rule without a storage
 * backend.
 */
export function togglePaneDiagnostics(ids: readonly string[], subshellId: string): string[] {
  return ids.includes(subshellId) ? ids.filter((id) => id !== subshellId) : [...ids, subshellId];
}
