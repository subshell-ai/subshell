import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { buildTerminalHtml, TERMINAL_HTML_PATH } from "../../scripts/sync-terminal-assets";

/**
 * `assets/terminal.html` is GENERATED: it inlines xterm's bundle, its CSS and
 * the fit addon into one self-contained page, because the WebView's opaque
 * origin cannot fetch them. Regenerating it after an `@xterm/*` bump is a
 * manual step documented only in prose, with no build task behind it — so
 * nothing but this test notices when it is skipped.
 *
 * It has been skipped before. The committed file predating this guard carried
 * xterm bytes matching NEITHER pinned version: a formatter had rewritten the
 * inlined bundle in place (arrow functions for `!function`, `===` for `==`)
 * before the biome exclusion was added, and it stayed that way through a
 * dependency bump. A mobile terminal running a mangled, stale emulator is not
 * a failure anyone would attribute to this file.
 */
describe("assets/terminal.html is in step with the pinned @xterm packages", () => {
  it("matches what the generator produces right now, byte for byte", () => {
    const committed = readFileSync(TERMINAL_HTML_PATH, "utf8");
    const expected = buildTerminalHtml();
    // Compared by length first: a byte-diff of a 400KB inlined bundle is
    // unreadable, and the length alone names the likely cause.
    expect(committed.length).toBe(expected.length);
    expect(committed).toBe(expected);
  });

  /**
   * The page's touch handling listens for xterm's OWN gesture events by
   * name, because on a phone they are the only touch signal that survives:
   * the gesture service preventDefaults touchstart and touchend, so no
   * compatibility mouse event is ever synthesised. Those names are internal
   * to xterm (`browser/Gesture.ts`'s EventType), so a version bump can
   * rename them — and a listener bound to a name nothing dispatches is
   * silent, not broken. Nothing else would notice: the keyboard would simply
   * stop opening on tap, on a device, weeks later.
   */
  it("listens for gesture event names the installed xterm still dispatches", () => {
    const xterm = readFileSync(
      `${TERMINAL_HTML_PATH.replace(/assets\/terminal\.html$/, "")}node_modules/@xterm/xterm/lib/xterm.js`,
      "utf8",
    );
    const html = buildTerminalHtml();
    for (const event of ["-xterm-gesturetap", "-xterm-gesturechange"]) {
      expect(xterm).toContain(event);
      expect(html).toContain(event);
    }
  });

  it("really does inline the installed bundles, not a stale copy", () => {
    // Guards the guard: if `buildTerminalHtml` ever stopped reading
    // node_modules, the equality above would compare a constant with itself.
    const html = buildTerminalHtml();
    const xterm = readFileSync(
      `${TERMINAL_HTML_PATH.replace(/assets\/terminal\.html$/, "")}node_modules/@xterm/xterm/lib/xterm.js`,
      "utf8",
    );
    expect(html).toContain(xterm);
  });
});
