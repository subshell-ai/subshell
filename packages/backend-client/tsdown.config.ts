import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  sourcemap: false,
  target: ["es2024"],
  nodeProtocol: true,
  fixedExtension: false,
  // Keep the permitted server API type references external, including subpaths.
  external: ["@internal/server", "@internal/server/backup-types"],
  dts: true,
});
