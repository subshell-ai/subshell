/**
 * Regenerates assets/terminal.html — xterm + fit inlined into one
 * self-contained page (spec §Rendering: "xterm ships as a local asset, never
 * a CDN <script>"; the WebView's opaque origin could not fetch anyway).
 *
 * Run after bumping @xterm/* in apps/client/mobile/package.json:
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

      // Tap = "I want to type here". Dispatched synchronously out of
      // touchend, so the focus is still inside the user-gesture window iOS
      // wants before it will show a keyboard (the native side also passes
      // keyboardDisplayRequiresUserAction={false}, which covers N.focus()).
      // A scroll, a long press and a touch on the scrollbar all dispatch
      // something else and are deliberately not focus.
      host.addEventListener("-xterm-gesturetap", () => { if (!readOnly) term.focus(); }, true);

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
