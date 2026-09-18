/**
 * The last gate before what xterm emits becomes pane input.
 *
 * Everything `term.onData` produces is typed into a live pane, so a malformed
 * byte string is not a rendering glitch — it lands on whatever the harness has
 * at its prompt.
 *
 * This is a deliberate COPY of `apps/client/mobile/src/lib/terminal-input.ts`:
 * the two UI surfaces run the same xterm and hit the same upstream defect, and
 * this repo keeps the two copies rather than importing across apps.
 */

/**
 * The SGR (DECSET 1006) mouse report shape: `ESC [ < flags ; col ; row M|m`.
 * Matched loosely on purpose — the whole point is to catch reports whose
 * PARAMETERS are not numbers. The ESC is part of the match (a report dropped
 * without it leaves a bare Escape keypress behind), and no parameter class may
 * cross one, so a malformed report can never swallow the sequence after it.
 * Spelled `` rather than as the literal byte the mobile copy carries:
 * an invisible character in a regex is not reviewable.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the sequence being matched, not a stray byte
const SGR_MOUSE_REPORT = /\x1b\[<([^;\x1b]*);([^;\x1b]*);([^Mm;\x1b]*)[Mm]/g;

/** A parameter xterm could legitimately have produced: a plain decimal. */
const DECIMAL = /^\d{1,7}$/;

/**
 * Removes SGR mouse reports whose parameters are not decimal numbers, leaving
 * every other byte — real keystrokes, and well-formed reports — untouched.
 *
 * The defect it exists for (phone report, 2026-09-18: `aN;NaNMaN;NaNM…` typed
 * into a harness prompt): when the program in the pane enables mouse reporting
 * — tmux does — xterm turns a flick into SGR *wheel* reports. The frames while
 * the finger is down carry coordinates; the MOMENTUM frames do not.
 * `Gesture._inertia` builds its `-xterm-gesturechange` event with
 * `document.createEvent("CustomEvent")` and sets only `translationX/Y`, so
 * `MouseCoordsService.getMouseReportCoords` computes
 * `undefined - rect.left - padding` on both axes and the report leaves as
 * `ESC [ < 65 ; NaN ; NaN M`. The harness's input parser ends the CSI at the
 * `N` (a valid final byte) and prints the rest, which is exactly the garbage in
 * the report. Reproduced in this SPA on 2026-09-18 under Chromium coarse-
 * pointer emulation, with mouse reporting on: one flick sent 45 such frames and
 * the pane log shows them typed at the prompt. An upstream defect in
 * `@xterm/xterm@6.1.0-beta.304`, so this guard stays until a bump is proven to
 * fix it.
 *
 * Well-formed reports pass through, which is what keeps swipe-scrolling inside
 * a mouse-reporting program working.
 *
 * @param data - One chunk of terminal input (an `onData` payload)
 * @returns The chunk with unusable mouse reports removed (possibly empty)
 */
export function dropBrokenMouseReports(data: string): string {
  if (!data.includes("[<")) return data;
  return data.replace(SGR_MOUSE_REPORT, (whole, flags: string, col: string, row: string) =>
    DECIMAL.test(flags) && DECIMAL.test(col) && DECIMAL.test(row) ? whole : "",
  );
}
