import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  // React components ship as real JSX runtime calls, not a bundler-implicit
  // pragma: both consumers (the control-plane SPA and the node dashboard) are
  // Vite apps with React 19 installed, and `automatic` is what makes this
  // package's dist import `react/jsx-runtime` rather than a global `React`.
  jsx: "automatic",
  sourcemap: false,
  target: ["es2024"],
  fixedExtension: false,
  dts: true,
});
