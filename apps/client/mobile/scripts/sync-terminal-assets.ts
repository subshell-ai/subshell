/**
 * Regenerates assets/terminal.html — xterm, its CSS, the fit,
 * unicode-graphemes and web-links addons, and the shared `pane-url` core
 * from @internal/subshell-protocol, all inlined into one self-contained page
 * (spec §Rendering: "xterm ships as a local asset, never a CDN <script>"; the
 * WebView's opaque origin could not fetch anyway). The pane-url module is the
 * SAME source the web SPA and the mobile Log tab run — a tap means the same
 * thing on every device — transpiled here (sync, so the byte-equality guard
 * stays deterministic) and exposed as `window.PaneUrl`.
 *
 * Run after bumping @xterm/* in apps/client/mobile/package.json, or after
 * changing packages/subshell-protocol/src/pane-url.ts:
 *   bun scripts/sync-terminal-assets.ts
 * and COMMIT the generated file (Metro serves it as a bundled asset).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ASSET_ROOT = new URL("..", import.meta.url).pathname;

/** Where the generated page lives; Metro serves it as a bundled asset. */
export const TERMINAL_HTML_PATH = join(ASSET_ROOT, "assets/terminal.html");

/**
 * Builds the self-contained terminal page from the CURRENTLY INSTALLED
 * @xterm packages.
 *
 * Exported so a test can compare it against the committed file. Keeping the
 * two in step is otherwise a manual step documented only in prose — and it
 * had already been missed: the file committed before this guard carried
 * xterm bytes matching neither pinned version, having been rewritten in
 * place by a formatter before the biome exclusion was added.
 *
 * @returns The complete HTML document
 */
export function buildTerminalHtml(): string {
  const js = readFileSync(join(ASSET_ROOT, "node_modules/@xterm/xterm/lib/xterm.js"), "utf8");
  const css = readFileSync(join(ASSET_ROOT, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
  const fit = readFileSync(join(ASSET_ROOT, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), "utf8");
  const graphemes = readFileSync(
    join(ASSET_ROOT, "node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js"),
    "utf8",
  );
  const webLinks = readFileSync(join(ASSET_ROOT, "node_modules/@xterm/addon-web-links/lib/addon-web-links.js"), "utf8");
  // The shared tap core, read through the workspace symlink. SOURCE rather
  // than dist on purpose: the guard test builds the page without a prior
  // turbo build, and the transform erases the types either way. The export
  // list is derived from the same text, never hand-copied, so a new exported
  // function reaches the global without anyone remembering; the sync
  // transformSync output is byte-stable for a given input and Bun version.
  const paneUrlTs = readFileSync(join(ASSET_ROOT, "node_modules/@internal/subshell-protocol/src/pane-url.ts"), "utf8");
  const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(paneUrlTs);
  const paneUrlBody = transpiled.replace(/^export\s+/gm, "");
  const paneUrlExports = [...paneUrlTs.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]!).join(", ");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      ${css}
      html, body { margin: 0; height: 100%; background: #0a0c0f; overscroll-behavior: none; }
      #t { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="t"></div>
    <script>${js}</script>
    <script>${fit}</script>
    <script>${graphemes}</script>
    <script>${webLinks}</script>
    <script>(() => {
${paneUrlBody}
      window.PaneUrl = { ${paneUrlExports} };
    })();</script>
    <script>
      // Glue only (spec §Rendering). The page owns NO network.
      const post = (m) => { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} };
      const host = document.getElementById("t");
      const term = new Terminal({
        fontSize: 13,
        fontFamily: "Menlo, Courier New, monospace",
        cursorBlink: true,
        scrollback: 8000,
        theme: { background: "#0a0c0f", foreground: "#e4e4e7" },
      });
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      // Grapheme-cluster widths (2026-09-26 wave, the addon VS Code donated
      // upstream; the SPA loads the same package): a ZWJ family emoji is ONE
      // cell of width 2 and CJK/modern-emoji get their real widths, where
      // core's default tables are Unicode-6-era and mis-column modern
      // output. Loaded BEFORE open and before any write lands, so every row
      // this page renders is laid out by it — the same posture the web
      // terminal takes.
      term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
      // URLs become links. On a phone this addon mostly supplies the hover
      // underline for devices that DO have a pointer: xterm's gesture service
      // suppresses the compatibility mouse events a touch tap needs, so the
      // tap path below is the phone's route to a URL. Either route lands
      // here, and the uri is pane output — untrusted — so the http(s) gate
      // runs HERE as well as on the RN side before anything can open.
      term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => {
        if (/^https?:\\/\\//i.test(uri)) post({ type: "open", data: uri });
      }));
      term.open(host);

      // ---- touch ------------------------------------------------------
      // xterm's gesture service (browser/Gesture.ts) preventDefaults BOTH
      // touchstart and touchend on the screen element, which suppresses the
      // compatibility mouse events a browser would otherwise synthesise — so
      // on a phone xterm never sees a mousedown and never focuses the hidden
      // textarea that raises the keyboard. Its own gesture events are the
      // only touch signal left. They are dispatched on the screen element and
      // do NOT bubble (initEvent(type, false, true)), so every listener below
      // is capture-phase on the container, which still runs for a descendant
      // target. The names are xterm's EventType enum, measured in the
      // @xterm/xterm@6.1.0-beta.304 bundle; if a bump renames them these
      // listeners go quiet rather than wrong, and RN's own guard still holds.
      let readOnly = false;
      let lastX = 0;
      let lastY = 0;
      const trackTouch = (e) => {
        const t = e.touches && e.touches[0];
        if (t) { lastX = t.clientX; lastY = t.clientY; }
      };
      host.addEventListener("touchstart", trackTouch, { capture: true, passive: true });
      host.addEventListener("touchmove", trackTouch, { capture: true, passive: true });

      // A flick is reported to a mouse-reporting program (tmux is one) as SGR
      // wheel events. Gesture._inertia builds the MOMENTUM frames with a bare
      // CustomEvent carrying only translationX/Y, so xterm reads clientX as
      // undefined and emits "ESC [ < 65 ; NaN ; NaN M" straight into the pane
      // (phone report, 2026-09-18). Fill the coordinates in before xterm
      // reads them: the finger has lifted, so its last position is the honest
      // answer to "where did this wheel happen", and momentum scrolling keeps
      // working instead of being thrown away.
      host.addEventListener("-xterm-gesturechange", (e) => {
        if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) {
          e.clientX = lastX;
          e.clientY = lastY;
        }
      }, true);

      // Where a tap landed, resolved through the SHARED pane-url core: the
      // cell under the point (the measured .xterm-screen rect over
      // dimensions.css.cell, viewportY for the client scroll), then the
      // token walked along this buffer's own isWrapped seam chain. The web
      // SPA runs the identical sequence in terminalUrlAtPoint — same core,
      // so a wrapped URL opens whole here exactly as it does there.
      const urlAt = (x, y) => {
        const dims = term.dimensions;
        const screen = host.querySelector(".xterm-screen");
        if (!dims || !screen || !window.PaneUrl) return null;
        const point = window.PaneUrl.cellAtPoint({
          x,
          y,
          rect: screen.getBoundingClientRect(),
          cellWidth: dims.css.cell.width,
          cellHeight: dims.css.cell.height,
          cols: term.cols,
          rows: term.rows,
        });
        if (!point) return null;
        const buffer = term.buffer.active;
        const lineIndex = buffer.viewportY + point.row;
        const bufferLine = buffer.getLine(lineIndex);
        if (!bufferLine) return null;
        const line = bufferLine.translateToString(true);
        return window.PaneUrl.urlTokenAt({
          line,
          cells: window.PaneUrl.tapCellsOfLine(bufferLine, line),
          col: point.col,
          read: (offset) => {
            const row = buffer.getLine(lineIndex + offset);
            if (!row) return undefined;
            return { text: row.translateToString(true), wrapped: row.isWrapped === true };
          },
        });
      };

      // Tap = "open this link", or "I want to type here" when nothing under
      // the finger is one. Dispatched synchronously out of touchend, so the
      // focus is still inside the user-gesture window iOS wants before it
      // will show a keyboard (the native side also passes
      // keyboardDisplayRequiresUserAction={false}, which covers N.focus()).
      // A scroll, a long press and a touch on the scrollbar all dispatch
      // something else and are deliberately not focus. Link taps work in
      // read-only copy mode too — reading a link is not input, which is the
      // whole point of a tap that resolves before it focuses.
      host.addEventListener("-xterm-gesturetap", () => {
        const url = urlAt(lastX, lastY);
        if (url) post({ type: "open", data: url });
        else if (!readOnly) term.focus();
      }, true);

      term.onData((d) => post({ type: "keys", data: d }));
      term.onResize(({ cols, rows }) => post({ type: "size", cols, rows }));
      window.N = {
        write(s) { term.write(s); },
        reset() { term.reset(); },
        focus() { if (!readOnly) term.focus(); },
        blur() { term.blur(); },
        setReadOnly(v) { readOnly = !!v; if (readOnly) term.blur(); },
      };

      // ---- sizing -----------------------------------------------------
      const refit = () => { try { fitAddon.fit(); } catch (e) {} };
      refit();
      post({ type: "ready", cols: term.cols, rows: term.rows });
      window.addEventListener("resize", refit);
      // The keyboard opening shrinks this WebView without resizing the
      // window on iOS, and fit() is a no-op while the cell size is still 0 —
      // which would otherwise leave the pane at xterm's 80x24 default for
      // good. Both re-measure; onResize re-posts the size, so the "ready"
      // above stays honest whichever one lands first.
      if (window.ResizeObserver) new ResizeObserver(refit).observe(host);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit).catch(() => {});
    </script>
  </body>
</html>
`;
}

// Only when run directly: importing this for its builder must not write.
if (import.meta.main) {
  mkdirSync(join(ASSET_ROOT, "assets"), { recursive: true });
  const html = buildTerminalHtml();
  writeFileSync(TERMINAL_HTML_PATH, html);
  console.log(`wrote assets/terminal.html (${html.length} bytes)`);
}
