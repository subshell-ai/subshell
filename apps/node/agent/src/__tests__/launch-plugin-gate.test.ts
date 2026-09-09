import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLaunchPlugin } from "../launch-plugin.js";
import { installEmbedded, pluginsDir } from "../plugins-dir.js";

/**
 * The node enforces its own declaration.
 *
 * The control plane filters too, but a signature proves WHO sent a launch,
 * never whether this machine can serve it. Before this, the node resolved
 * through the registry compiled into its binary, so it would happily launch a
 * harness nobody had installed on it. Same reasoning as `allowed-dirs`, and
 * the same reason it cannot live only on the control plane.
 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "launch-gate-"));
}

describe("resolveLaunchPlugin", () => {
  it("resolves a plugin this node has installed", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "claude-code");
    const result = await resolveLaunchPlugin(dir, "claude-code");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.manifest.id).toBe("claude-code");
    expect(typeof result.plugin.buildCommand).toBe("function");
  });

  it("refuses a plugin this node does not have, naming it", async () => {
    const result = await resolveLaunchPlugin(tempDataDir(), "codex");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("codex");
    expect(result.error).toContain("not installed");
  });

  it("refuses a plugin the BINARY knows about but the node has not installed", async () => {
    // The exact hole this closes: `getHarness` would have answered, because
    // the built-in registry is compiled in regardless of what is on disk.
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    expect("error" in (await resolveLaunchPlugin(dir, "claude-code"))).toBe(true);
  });

  it("refuses a plugin that is installed but broken", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "hermes");
    await writeFile(join(pluginsDir(dir), "hermes", "dist", "index.js"), "throw new Error('boom');", "utf8");
    const result = await resolveLaunchPlugin(dir, "hermes");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("boom");
  });

  it("refuses an id that is not a safe path segment", async () => {
    const result = await resolveLaunchPlugin(tempDataDir(), "../escape");
    expect("error" in result).toBe(true);
  });
});
