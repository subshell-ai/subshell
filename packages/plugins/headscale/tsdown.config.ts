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
  //
  // `@subshell-ai/plugin-tailscale` is deliberately NOT in this list: this
  // package COPIES the shared source instead of inlining it, because the
  // tailscale package exports only its factory and manifest — reusing its
  // helpers by inlining would mean widening a shipped package's public API,
  // and importing its module graph would parse tailscale's manifest at load,
  // which § 4 forbids. See `src/cli.ts` and the containment test.
  noExternal: ["@subshell-ai/plugin-api"],
});
