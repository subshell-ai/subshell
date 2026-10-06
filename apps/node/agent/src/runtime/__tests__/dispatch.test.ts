import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../../commands/context.js";
import type { NodeConfig } from "../../config.js";
import { SubshellMetaStore } from "../../subshell-meta.js";
import { runRuntimeCommand } from "../dispatch.js";

/**
 * The runtime dispatcher's task-25 arms. `detect` must answer through the
 * AGENT'S OWN executor (plane-parses-version posture, inversion §4: raw text
 * out, never a plugin interpretation), and it answers ONLY what was asked -
 * the "plane asks; the runtime answers" rule the node link pins and the
 * runtime inherits. Unknown frames keep the named `unsupported` refusal (a
 * detect aimed at a dispatcher that cannot run it is a refusal, not silence).
 */

const dataDir = mkdtempSync(join(tmpdir(), "subshell-dispatch-"));

// The temp dir is LIVE while the tests run: bun evaluates the whole file
// before executing any test, so a top-level `rmSync` at the foot of the file
// deleted it before the first test started. Cleanup belongs in `afterAll`.
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const config: NodeConfig = {
    serverUrl: "",
    nodeId: "runtime:test",
    nodeKey: "",
    controlPublicKey: "",
    dataDir,
    name: "runtime-serve",
  };
  return {
    config,
    tmux: {} as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => 1_700_000_000_000,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
}

describe("runtime dispatch: detect", () => {
  test("answers the specs' raw rows and ONLY the named env", async () => {
    const result = await runRuntimeCommand(makeCtx(), "subshell-dest", {
      type: "detect",
      ref: "r-1",
      specs: [
        { id: "no-binary-harness", binaryName: "", envOverride: "", knownPaths: [] },
        { id: "missing-harness", binaryName: "definitely-not-installed-xyz", envOverride: "", knownPaths: [] },
      ],
      envNames: ["PATH", "SUBSHELL_DISPATCH_TEST_UNSET"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { results: unknown[]; env: Record<string, string> };
    expect(data.results).toEqual([
      { harnessId: "no-binary-harness", installed: false, reason: "no-binary" },
      { harnessId: "missing-harness", installed: false, reason: "not-on-path" },
    ]);
    // Only asked, only present: PATH exists in every test env; the sentinel
    // name must not appear at all (the answer never scans).
    expect(Object.keys(data.env)).toEqual(["PATH"]);
  });

  test("a malformed specs element (deep grammar) is refused by name before any probe", async () => {
    const result = await runRuntimeCommand(makeCtx(), "subshell-dest", {
      type: "detect",
      ref: "r-2",
      // Shallow-parsed by the session frame parser; the DEEP node-link grammar
      // is re-run here, and `binaryName: 5` must die at the parse, not reach
      // detectBinary.
      specs: [{ id: "x", binaryName: 5 } as never],
      envNames: [],
    });
    expect(result).toEqual({ ok: false, error: "unsupported" });
  });
});

describe("runtime dispatch: named refusals unchanged", () => {
  test("an unknown frame type answers the bare unsupported code", async () => {
    const result = await runRuntimeCommand(makeCtx(), "subshell-dest", {
      type: "teleport" as never,
      ref: "r-3",
    });
    expect(result).toEqual({ ok: false, error: "unsupported" });
  });
});
