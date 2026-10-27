import { defineConfig } from "vite";
import { panelSingleFile } from "./inline.ts";

/**
 * The macOS display helper's settings panel, built to `dist/` and copied into
 * the helper bundle by `native/display-helper/build_support.rs`.
 *
 * The output is ONE self-contained `index.html`, which `panelSingleFile`
 * enforces. It is not about size. The helper loads the page with `loadFileURL`,
 * and WebKit gives a `file://` document an opaque origin, so vite's usual
 * `crossorigin` module script and stylesheet become CORS requests from a `null`
 * origin that WebKit refuses: the document arrives, nothing else does, and the
 * person gets a white window. Inlined, the page issues no request at all, so
 * what it shows can only come from the helper's own bundle, and there is one
 * signed file to check rather than a folder of them.
 */
export default defineConfig({
  // Relative anyway, so a leaked URL would point inside the bundle rather than
  // at a server; the inline plugin refuses to leave one in the document.
  base: "./",
  plugins: [panelSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // One stylesheet rather than styles injected by the script: the panel's
    // chrome should paint correctly from the document itself, so a script that
    // fails cannot bring back the white window this build exists to prevent.
    cssCodeSplit: false,
    // The inlined script is a classic script, so it must not be emitted as a
    // module, and nothing may fetch it through a preload link either.
    modulePreload: false,
    rollupOptions: {
      output: { format: "iife" },
    },
  },
});
