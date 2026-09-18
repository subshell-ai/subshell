/**
 * The last gate before a renderer payload becomes pane input.
 *
 * Everything the WebView posts as `{type:"keys"}` reaches `sendInput` and is
 * typed into a live pane, so a malformed byte string is not a rendering
 * glitch — it lands in whatever the harness has on its prompt.
 */

/**
 * The SGR (DECSET 1006) mouse report shape: `ESC [ < flags ; col ; row M|m`.
 * Matched loosely on purpose — the whole point is to catch reports whose
 * PARAMETERS are not numbers.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the sequence being matched, not a stray byte
const SGR_MOUSE_REPORT = /\[<([^;]*);([^;]*);([^Mm;]*)[Mm]/g;

/** A parameter xterm could legitimately have produced: a plain decimal. */
const DECIMAL = /^\d{1,7}$/;

/**
 * Removes SGR mouse reports whose parameters are not decimal numbers,
 * leaving every other byte — real keystrokes included — untouched.
 *
 * The defect it exists for (phone report, 2026-09-18: `aN;NaNMaN;NaNM…`
 * typed into a Claude Code prompt): when the program in the pane enables
 * mouse reporting — tmux does — xterm turns a flick into SGR *wheel*
 * reports. The frames while the finger is down carry coordinates; the
 * MOMENTUM frames do not. `Gesture._inertia` builds its
 * `-xterm-gesturechange` event with `document.createEvent("CustomEvent")`
 * and sets only `translationX/Y`, so `MouseCoordsService.getMouseReportCoords`
 * computes `undefined - rect.left - padding` for both axes and the report
 * leaves as `ESC [ < 65 ; NaN ; NaN M`. The harness's input parser ends the
 * CSI at the `N` (a valid final byte) and prints the rest, which is exactly
 * the garbage in the report. Verified by reading the shipped bundle of
 * `@xterm/xterm@6.1.0-beta.304`; it is an upstream defect, so this guard
 * stays until a bump is proven to fix it.
 *
 * The page repairs the coordinates at their source as well (see
 * `scripts/sync-terminal-assets.ts`). This is the half that can be tested,
 * and the half that still holds if a version bump renames xterm's internal
 * gesture events out from under that repair.
 *
 * @param data - One `{type:"keys"}` payload from the renderer
 * @returns The payload with unusable mouse reports removed (possibly empty)
 */
export function dropBrokenMouseReports(data: string): string {
  if (!data.includes("[<")) return data;
  return data.replace(SGR_MOUSE_REPORT, (whole, flags: string, col: string, row: string) =>
    DECIMAL.test(flags) && DECIMAL.test(col) && DECIMAL.test(row) ? whole : "",
  );
}
