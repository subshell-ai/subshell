/**
 * Keyboard chords the subshell terminal handles itself rather than encoding
 * for the pane.
 */

/**
 * The paste chord (Ctrl+V, or Cmd+V on macOS).
 *
 * Two call sites must agree on this exactly, which is why it lives here:
 *
 * - `subshell-terminal.tsx` returns `false` from xterm's custom key handler
 *   for it, so xterm does NOT encode the chord as `\x16` and send it to the
 *   pane. It used to: the harness CLI in the pane treats `\x16` as its own
 *   paste shortcut and reads the SERVER's clipboard, which is how "No image
 *   found in clipboard" appeared on a user's screen while the image sat in
 *   their browser's clipboard the whole time (2026-09-02).
 * - `use-terminal-uploads.ts` arms its no-paste-event fallback on it.
 *
 * `altKey` is excluded so Alt/Option combinations still reach the pane as
 * ordinary input. Shift is deliberately NOT excluded: Ctrl+Shift+V is
 * "paste as plain text" in Chrome and fires a paste event just the same.
 */
export function isPasteChord(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v";
}
