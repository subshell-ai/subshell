/**
 * Regenerates assets/terminal.html — xterm + fit inlined into one
 * self-contained page (spec §Rendering: "xterm ships as a local asset, never
 * a CDN <script>"; the WebView's opaque origin could not fetch anyway).
 *
 * Run after bumping @xterm/* in apps/mobile/package.json:
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
      // Glue only (~35 lines, spec §Rendering). The page owns NO network.
      const post = (m) => { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} };
      const term = new Terminal({
        fontSize: 13,
        fontFamily: "Menlo, Courier New, monospace",
        cursorBlink: true,
        scrollback: 8000,
        theme: { background: "#0a0c0f", foreground: "#e4e4e7" },
      });
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById("t"));
      fitAddon.fit();
      term.onData((d) => post({ type: "keys", data: d }));
      term.onResize(({ cols, rows }) => post({ type: "size", cols, rows }));
      window.N = {
        write(s) { term.write(s); },
        reset() { term.reset(); },
      };
      post({ type: "ready", cols: term.cols, rows: term.rows });
      window.addEventListener("resize", () => fitAddon.fit());
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
