import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/release-artifacts.ts",
    "src/release-signature.ts",
    "src/service-test-safety.ts",
    "src/wire.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  sourcemap: false,
  target: ["es2024"],
  nodeProtocol: true,
  fixedExtension: false,
  dts: true,
});
