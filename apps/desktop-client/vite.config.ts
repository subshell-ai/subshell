import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The dev-server port `src-tauri/tauri.conf.json`'s `devUrl` dials.
 *
 * Deliberately not adjacent to `apps/frontend`'s 5174: Vite walks upward from a
 * taken port, so 5175 would be exactly the port the SPA lands on when 5174 is
 * already in use — and `devUrl` is a fixed string, so the app would then load
 * the wrong product's page. `strictPort` turns that class of mistake into a
 * refusal to start rather than a confusing window.
 */
const DEV_PORT = 5177;

export default defineConfig({
  // `ui/` is the Vite root, so `index.html` and `src/` sit together and the
  // app's own `src/` (the release script, run by bun, type-checked by its own
  // tsconfig) is not part of the web build at all.
  root: path.resolve(dirname, "ui"),
  // Tauri loads the built page from `tauri://localhost` / `http://tauri.localhost`,
  // where an absolute `/assets/...` URL resolves — but a relative one survives
  // both that and being opened as a file, and costs nothing.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "ui/src"),
    },
  },
  build: {
    // Relative to `root`, i.e. apps/desktop-client/ui/dist.
    outDir: "dist",
    emptyOutDir: true,
    // The webviews this bundle ever runs in: macOS 13+ (bundle
    // `minimumSystemVersion`) is WebKit 16, and the Linux shard's
    // WebKitGTK on Ubuntu 24.04 is newer still.
    target: "safari16",
    // BOTH of these keep the emitted HTML CSP-clean under
    // `script-src 'self'; style-src 'self'` — see the note on `csp` in
    // tauri.conf.json. Vite's module-preload polyfill is injected as an
    // INLINE <script>, which that policy blocks silently; and an asset under
    // `assetsInlineLimit` becomes a `data:` URL, which `default-src 'self'`
    // blocks for every type this page could load.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  server: {
    // Loopback only (Vite's default host): this dev server serves one
    // developer's own window, and `devCsp` names exactly this origin.
    port: DEV_PORT,
    strictPort: true,
  },
});
