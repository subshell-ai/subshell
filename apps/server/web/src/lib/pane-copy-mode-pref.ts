/**
 * Which subshells are in COPY MODE on this device (issue 242). Exactly the
 * same per-DEVICE, per-subshell tier as `pane-diagnostics-pref` and for the
 * same reasons: a selection gesture you asked for on this screen is a
 * property of the screen, not of the account; the set holds the TURNED-ON
 * ids because off is the default; keyed by subshell ID so a rename changes
 * no stored preference; and every access is try/catch'd because private-mode
 * Safari throws on `localStorage` outright.
 *
 * It also keeps the same page-load memory, for the same reason. Two surfaces
 * read this set (the actions menu and the touch bar) and either can toggle it,
 * so when the device will not store anything they have to be told the same
 * answer by the module rather than one taking the click and the other
 * re-reading a store that never changed.
 */

/** Window event telling every reader on this page that the set changed. */
export const PANE_COPY_MODE_CHANGED = "subshell:copy-mode-changed";

/** JSON array of subshell ids whose pane is in copy mode on this device. */
const KEY = "subshell.paneCopyMode";

/**
 * The turned-on set, or an empty array for absent/corrupt/blocked storage.
 * A half-written or hand-edited value is filtered to the strings inside it
 * rather than thrown away wholesale.
 */
let lastWritten: string[] | undefined;
let writeRefused = false;

export function paneCopyModeIds(): string[] {
  // Once a write has been refused this page load, the attempted set IS the
  // device's answer: the store still holds whatever it held before, and the two
  // surfaces asking about it would diverge on that.
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
 * Persists the set and tells every reader on this page.
 *
 * @param ids - the set as it should now be stored
 * @returns the set this page now holds, so callers bind their render to that
 *          rather than to what they intended to store. It is what was stored when
 *          the device accepted the write, and what was attempted when it refused
 *          one, which is what keeps the menu and the touch bar in step.
 */
export function setPaneCopyModeIds(ids: readonly string[]): string[] {
  const next = [...ids];
  // A copy, not the returned array: every read path hands out a copy too, and a
  // caller that sorted or spliced what it got back would otherwise rewrite this
  // page's memory of what the device stores.
  lastWritten = [...next];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused (private mode, quota): the choice still holds for this
    // page load, and `paneCopyModeIds` now answers from it so every instance on
    // the page agrees rather than half of them reading a stale store.
    writeRefused = true;
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PANE_COPY_MODE_CHANGED));
  return next;
}

/**
 * The browser fires `storage` only when a write actually landed, which is proof
 * this device accepts writes again: any page-load memory from an earlier refusal
 * is now the stale one. Cleared at module scope, beside the memory itself, so
 * every reader agrees whether or not it subscribed. Registered before any
 * subscriber, so the memory is gone by the time a listener re-reads.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: Event) => {
    if (event instanceof StorageEvent && event.key !== null && event.key !== KEY) return;
    writeRefused = false;
    lastWritten = undefined;
  });
}

/**
 * Drops the page-load memory of what was written. For tests only: the module
 * keeps one answer across a page load on purpose, and a suite that shares this
 * worker would otherwise read another file's refused write as its own state.
 * @internal
 */
export function resetPaneCopyModePrefForTests(): void {
  lastWritten = undefined;
  writeRefused = false;
}

/**
 * The set with one subshell's copy mode flipped. Pure, so the caller decides
 * whether to persist it and a test can exercise the rule without a storage
 * backend.
 */
export function togglePaneCopyMode(ids: readonly string[], subshellId: string): string[] {
  return ids.includes(subshellId) ? ids.filter((id) => id !== subshellId) : [...ids, subshellId];
}
