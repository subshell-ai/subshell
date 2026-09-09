import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  sourcemap: false,
  target: ["es2024"],
  nodeProtocol: true,
  fixedExtension: false,
  dts: true,
  // A plugin is loaded from disk by a compiled binary and CANNOT resolve a
  // bare specifier, so nothing of ours may survive as an import in the output.
  // plugin-api is types plus pure helpers, which is exactly what makes it safe
  // to inline here.
  noExternal: ["@subshell-ai/plugin-api"],
});
