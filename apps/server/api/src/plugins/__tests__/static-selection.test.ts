import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectStaticPlugin } from "@/plugins/static.plugin.js";

/**
 * Boot-time source selection (spec 2026-09-03 §4): a dist dir on disk wins,
 * else the embedded map, else the loud boot error. server.ts wires this with
 * its FRONTEND_DIST + the generated EMBEDDED flag — the branches are asserted
 * here without booting the full app.
 */
const makeRoot = (withIndex: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), "subshell-static-select-"));
  if (withIndex) writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
  return root;
};

describe("selectStaticPlugin", () => {
  it("prefers the disk plugin when index.html exists on disk — even with embedded assets", () => {
    const root = makeRoot(true);
    try {
      const plugin = selectStaticPlugin(root, true);
      // The disk factory is chosen; the embedded name must never appear.
      expect(plugin.config.name).toBe("subshell-static");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the embedded branch when the disk dist is missing but EMBEDDED is set", () => {
    // The committed generated stub ships an EMPTY map, so the embedded
    // factory's own boot assertion (/index\.html/ missing) proves the
    // embedded branch — and only the embedded branch — was taken.
    const root = join(makeRoot(false), "nope");
    try {
      expect(() => selectStaticPlugin(root, true)).toThrow(/index\.html/);
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("fails loudly when neither the disk dist nor embedded assets exist", () => {
    const root = makeRoot(false);
    try {
      expect(() => selectStaticPlugin(root, false)).toThrow(
        new RegExp(`built frontend not found at .*${root.split("/").pop()}.* no embedded assets in this binary`),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
