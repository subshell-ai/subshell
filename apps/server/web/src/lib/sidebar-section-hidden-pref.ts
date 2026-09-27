/**
 * Which whole sidebar SECTIONS a person has folded away with their eye toggle
 * (operator ask 2026-09-27), so a long Subshells or Workspaces list cannot
 * push the sections below it out of reach.
 *
 * A JSON object of `{ [sectionId]: true }` — only the TRUE entries are stored,
 * so an absent section is shown, the value stays small, and a newly-added nav
 * section defaults visible. Per-DEVICE like the rail's other preferences: how
 * tall you like the rail is a property of the screen, not of the account.
 *
 * The component holds the state (it must re-render on a press); this module
 * owns the SHAPE: what reads back from storage, and the two transitions
 * (toggle, force-shown) as pure functions so the rules are testable without a
 * React tree. Every storage access is try/catch'd — private-mode Safari throws
 * outright, and a rail that cannot render because it lost a cosmetic
 * preference is worse than one that forgets it.
 */

/** localStorage key holding the hidden-section map. */
const KEY = "subshell.sidebarHiddenSections";

/**
 * The map, or empty for absent/corrupt/blocked storage. Never throws.
 *
 * Inherited faithfully: a stored JSON ARRAY passes the object guard below
 * (`typeof [] === "object"`). It is inert — `hiddenSections[id] === true` is
 * never true against an array, so it reads as "nothing hidden", the same
 * answer as `{}` — which is why it is noted rather than tested.
 */
export function readHiddenSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Best-effort persist; a refused write still leaves the toggle working this session. */
export function writeHiddenSections(next: Record<string, boolean>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode) — the toggle still works this session
  }
}

/** The map with one section flipped: hidden becomes shown, shown becomes hidden. */
export function toggleHidden(prev: Record<string, boolean>, id: string): Record<string, boolean> {
  const next = { ...prev };
  if (next[id]) delete next[id];
  else next[id] = true;
  return next;
}

/**
 * The map with one section FORCED shown (never flipped) — ⌘F reveals the
 * Subshells rail before focusing the filter inside it, and a section that was
 * already visible stays put.
 */
export function revealHidden(prev: Record<string, boolean>, id: string): Record<string, boolean> {
  if (!prev[id]) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}
