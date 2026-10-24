import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { cellAtPoint, findUrlsInLine, urlTokenAt } from "@internal/subshell-protocol";
import { buildTerminalHtml, TERMINAL_HTML_PATH } from "../../scripts/sync-terminal-assets";

/**
 * `assets/terminal.html` is GENERATED: it inlines xterm's bundle, its CSS,
 * the fit, unicode-graphemes and web-links addons, and the shared `pane-url`
 * core into one self-contained page, because the WebView's opaque origin
 * cannot fetch them. Regenerating it after an `@xterm/*` bump or a pane-url
 * edit is a
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
    const read = (pkg: string, file: string) =>
      readFileSync(`${TERMINAL_HTML_PATH.replace(/assets\/terminal\.html$/, "")}node_modules/${pkg}/${file}`, "utf8");
    expect(html).toContain(read("@xterm/xterm", "lib/xterm.js"));
    expect(html).toContain(read("@xterm/addon-web-links", "lib/addon-web-links.js"));
  });
});

/**
 * The tap handler resolves URLs through `window.PaneUrl`, the inlined copy
 * of the protocol's `pane-url.ts`. The generator transpiles the source and
 * DERIVES the global's export list from the same text, so a plain textual
 * check would pass even if the shim were broken. This runs the embedded IIFE
 * the way the page does and then feeds the SAME inputs to the embedded copy
 * and to the imported module: if the transpile emitted syntax a browser
 * cannot parse, if the shim dropped an export, or if the embedded answer
 * drifted from the one the SPA gives, this fails here instead of on a device.
 */
describe("the embedded pane-url core", () => {
  it("evaluates, carries the module's exports, and answers like the imported module", () => {
    const html = buildTerminalHtml();
    const tag = html.match(/<script>\(\(\) => \{[\s\S]*?window\.PaneUrl = \{[^}]*\};\s*\}\)\(\);<\/script>/);
    expect(tag).not.toBeNull();
    const win: Record<string, unknown> = {};
    new Function("window", tag![0].slice("<script>".length, -"</script>".length))(win);
    const paneUrl = win.PaneUrl as Record<string, unknown>;
    // The derived global's full surface, pinned. The page calls three of
    // these (cellAtPoint, tapCellsOfLine, urlTokenAt); the rest ride along
    // because the module exports them, and every one has to be THERE, since
    // renaming or dropping one without the page is how a tap goes quiet on
    // devices only. The set is derived from the module's own source: a
    // hand-copied list here would stay green even after the generator's
    // derivation silently started missing a newly added export.
    const paneUrlTs = readFileSync(
      `${TERMINAL_HTML_PATH.replace(/assets\/terminal\.html$/, "")}node_modules/@internal/subshell-protocol/src/pane-url.ts`,
      "utf8",
    );
    const exported = [...paneUrlTs.matchAll(/^export (?:async\s+)?(?:function\s*\*?|const|let|class)\s+(\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(Object.keys(paneUrl).sort()).toEqual(exported.sort());

    const call = (name: string) => {
      const fn = paneUrl[name];
      expect(typeof fn).toBe("function");
      return fn as (input: unknown) => unknown;
    };
    const line = "go https://example.com/a";
    const cells = [...line].map((char) => ({ char, width: 1 }));
    // A tap on a plain word (nothing to open) and on the URL itself.
    expect(call("urlTokenAt")({ line, cells, col: 0 })).toBe(urlTokenAt({ line, cells, col: 0 }));
    expect(call("urlTokenAt")({ line, cells, col: 5 })).toBe(urlTokenAt({ line, cells, col: 5 }));
    // The seam walk this feature turns on: a URL wrapped across two buffer
    // rows must come back WHOLE from the embedded copy, exactly as from the
    // module the web SPA runs.
    const wrappedLine = "go https://example.co";
    const wrapped = {
      line: wrappedLine,
      cells: [...wrappedLine].map((char) => ({ char, width: 1 })),
      col: 5,
      read: (offset: number) =>
        offset === 1
          ? { text: "m/a", wrapped: true }
          : offset === 0
            ? { text: wrappedLine, wrapped: false }
            : undefined,
    };
    expect(call("urlTokenAt")(wrapped)).toBe("https://example.com/a");
    expect(call("urlTokenAt")(wrapped)).toBe(urlTokenAt(wrapped));
    // The Log tab's splitter, and the page's cell math, same inputs, same answers.
    const scan = "open https://x.dev/a. then https://y.dev/b!";
    expect(call("findUrlsInLine")(scan)).toEqual(findUrlsInLine(scan));
    const point = { x: 37, y: 14, rect: { left: 0, top: 0 }, cellWidth: 7, cellHeight: 14, cols: 80, rows: 24 };
    expect(call("cellAtPoint")(point)).toEqual(cellAtPoint(point));
  });
});
