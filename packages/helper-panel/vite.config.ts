import { defineConfig } from "vite";

/**
 * The macOS display helper's settings panel, built to `dist/` and copied into
 * the helper bundle by `native/display-helper/build_support.rs`.
 *
 * `base: "./"` is not a style choice: the Swift side loads `index.html` with
 * `loadFileURL`, so the asset URLs have to be relative to the bundle directory
 * and nothing may reach for a server. The page gets no network access beyond
 * that directory (the read scope is the panel folder), which is the whole
 * security property a consent surface needs: what it shows comes from the
 * helper process, and it can fetch nothing else.
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
