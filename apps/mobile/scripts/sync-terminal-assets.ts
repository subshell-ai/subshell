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

const root = new URL("..", import.meta.url).pathname;
mkdirSync(join(root, "assets"), { recursive: true });
const js = readFileSync(join(root, "node_modules/@xterm/xterm/lib/xterm.js"), "utf8");
const css = readFileSync(join(root, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
const fit = readFileSync(join(root, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), "utf8");

const html = `<!doctype html>
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

writeFileSync(join(root, "assets/terminal.html"), html);
console.log(`wrote assets/terminal.html (${html.length} bytes)`);
