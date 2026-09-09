import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, parseManifest } from "../manifest.js";

/** A package.json that a valid plugin would ship. */
function pkg(over: Record<string, unknown> = {}): unknown {
  return {
    name: "@subshell-ai/plugin-claude-code",
    version: "1.0.0",
    subshell: {
      apiVersion: PLUGIN_API_VERSION,
      id: "claude-code",
      type: "agent-harness",
      name: "Claude Code",
      description: "Anthropic's agentic coding assistant",
      entry: "dist/index.js",
      detect: { binaryName: "claude", envOverride: "CLAUDE_PATH", knownPaths: [".local/bin/claude"] },
      install: { command: "npm i -g @anthropic-ai/claude-code", docsUrl: "https://example.invalid" },
      ...over,
    },
  };
}

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseManifest(pkg());
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.id).toBe("claude-code");
    expect(result.type).toBe("agent-harness");
    expect(result.detect?.binaryName).toBe("claude");
  });

  it("rejects a package.json with no subshell key", () => {
    expect("error" in parseManifest({ name: "x", version: "1.0.0" })).toBe(true);
  });

  it("rejects something that is not an object at all", () => {
    expect("error" in parseManifest(null)).toBe(true);
    expect("error" in parseManifest("nope")).toBe(true);
  });

  it("rejects an apiVersion this host cannot serve, naming both numbers", () => {
    const result = parseManifest(pkg({ apiVersion: PLUGIN_API_VERSION + 1 }));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    // The reader has to decide whether to upgrade the plugin or the agent, and
    // one number cannot tell them that.
    expect(result.error).toContain(String(PLUGIN_API_VERSION));
    expect(result.error).toContain(String(PLUGIN_API_VERSION + 1));
  });

  it("accepts every version from 1 up to this host's, which is the point of the field", () => {
    // A host at version N keeps serving plugins built against 1..N. Written as
    // a range rather than `PLUGIN_API_VERSION - 1`, which is 0 today and is
    // now correctly refused as a version that never existed.
    for (let v = 1; v <= PLUGIN_API_VERSION; v++) {
      expect([v, "error" in parseManifest(pkg({ apiVersion: v }))]).toEqual([v, false]);
    }
  });

  it("refuses a version below 1", () => {
    for (const apiVersion of [0, -1]) {
      const result = parseManifest(pkg({ apiVersion }));
      expect("error" in result).toBe(true);
      if (!("error" in result)) continue;
      expect(result.error).toContain("not a version");
    }
  });

  it("rejects an unknown plugin type rather than guessing", () => {
    expect("error" in parseManifest(pkg({ type: "wat" }))).toBe(true);
  });

  it("accepts every type it claims to support", () => {
    for (const type of ["agent-harness", "terminal"]) {
      expect("error" in parseManifest(pkg({ type }))).toBe(false);
    }
  });

  it("rejects an id that is not a safe path segment", () => {
    // The id becomes a directory name under <dataDir>/plugins/.
    for (const id of ["../escape", "has space", "UPPER", "", "-leading", "a".repeat(65)]) {
      expect("error" in parseManifest(pkg({ id }))).toBe(true);
    }
  });

  it("rejects an entry that escapes the package directory", () => {
    for (const entry of ["../../etc/passwd", "/absolute/index.js", "", "nested/../../out.js"]) {
      expect("error" in parseManifest(pkg({ entry }))).toBe(true);
    }
  });

  it("accepts a nested entry that stays inside", () => {
    expect("error" in parseManifest(pkg({ entry: "dist/esm/index.js" }))).toBe(false);
  });

  it("accepts a manifest with no detect block, for a plugin that needs no binary", () => {
    const bare = pkg() as { subshell: Record<string, unknown> };
    delete bare.subshell.detect;
    const result = parseManifest(bare);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.detect).toBeUndefined();
  });

  it("rejects a half-written detect block", () => {
    expect("error" in parseManifest(pkg({ detect: { binaryName: "claude" } }))).toBe(true);
    expect("error" in parseManifest(pkg({ detect: { binaryName: "c", envOverride: "C", knownPaths: [1] } }))).toBe(
      true,
    );
  });

  it("carries the optional icon and install block through", () => {
    const result = parseManifest(pkg({ icon: "X" }));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.icon).toBe("X");
    expect(result.install?.docsUrl).toBe("https://example.invalid");
  });
});
