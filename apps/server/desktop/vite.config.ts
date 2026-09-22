import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The dev-server port `src-tauri/tauri.conf.json`'s `devUrl` dials.
 *
 * Deliberately not adjacent to anything another dev server lands on by
 * accident: `apps/server/web` starts at 5174 and walks upward when a port is
 * taken, `apps/client/desktop`'s page is strict on 5177, and `devUrl` here is
 * a fixed string — a drifted landing port would load a different product's
 * page into this window with no error anywhere. 5178 is above both, and
 * `strictPort` turns even a hand-taken 5178 into a refusal to start.
 */
const DEV_PORT = 5178;

export default defineConfig({
  // `ui/` is the Vite root, so `wizard.html` and `src/` sit together and the
  // app's own `src/` (the release script, run by bun, type-checked by its own
  // tsconfig) is not part of the web build at all.
  root: path.resolve(dirname, "ui"),
  // Tauri loads the built page from `tauri://localhost` / `http://tauri.localhost`,
  // where an absolute `/assets/...` URL resolves — but a relative one survives
  // both that and being opened as a file, and costs nothing. (Same reasoning
  // as `apps/client/desktop`'s config; this app predates it and now matches.)
  base: "./",
  // The shadcn kit the screens compose (`components/ui/`) imports through
  // `@/`, exactly as the client app's copy of the same files does — the files
  // are verbatim copies and their imports resolve the same way here.
  resolve: {
    alias: {
      "@": path.resolve(dirname, "ui/src"),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    // Relative to `root`, i.e. apps/server/desktop/ui/dist — which is what
    // `tauri.conf.json`'s frontendDist names. The assistant's logic lives in
    // `ui/src/`; the shipped asset root is only ever built output.
    outDir: "dist",
    emptyOutDir: true,
    // The webviews this bundle ever runs in: macOS 13+ (bundle
    // `minimumSystemVersion`) is WebKit 16, and the Linux shard's
    // WebKitGTK on Ubuntu 24.04 is newer still.
    target: "safari16",
    // BOTH of these keep the emitted HTML CSP-clean under
    // `script-src 'self'; style-src 'self'` — the policy in tauri.conf.json.
    // Vite's module-preload polyfill is injected as an INLINE <script>, which
    // that policy blocks silently; and an asset under `assetsInlineLimit`
    // becomes a `data:` URL, which `default-src 'self'` blocks for every type
    // this page could load. The assistant renders with the server DOWN on
    // someone's broken machine — a silently blank panel is the one failure
    // mode this app may not have.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: {
      // ONE bundled page: the assistant. `wizard.html` keeps that name
      // because the name is an IDENTIFIER — `WebviewUrl::App("wizard.html")`
      // in `windows.rs`, the `wizard` window label, and the capability file
      // keyed to it — while the page it carries is first run, recovery,
      // update and reset. Renaming it to `index.html` would move four things
      // to rename one.
      //
      // Named explicitly rather than left to Vite's default, which is
      // `index.html`: there is no `index.html` here, and a default that found
      // nothing would ship a bundle in which `WebviewUrl::App` resolves to a
      // 404 with no build error anywhere. Pinned by tauri-config.test.ts.
      input: {
        wizard: path.resolve(dirname, "ui/wizard.html"),
      },
    },
  },
  server: {
    // Loopback only (Vite's default host): this dev server serves one
    // developer's own window.
    port: DEV_PORT,
    strictPort: true,
  },
});
