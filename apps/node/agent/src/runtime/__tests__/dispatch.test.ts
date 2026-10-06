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

describe("runtime dispatch: probe resolves the launch-recorded socket", () => {
  /**
   * The runtime's panes live on the ONE destination-wide socket (design
   * 2026-10-05 §6), but `execProbe` used to re-derive the node link's
   * per-subshell socket from the id - so a probe answered `alive: false` for
   * a running runtime pane, and the live-terminal attach (whose first step
   * is the probe) closed every runtime browser at 4004 "subshell not
   * running". The fix is the shared `resolveSocket`: the launch record's
   * socket wins, the derivation stays the orphan fallback.
   */
  test("a pane on the destination socket probes alive; the derived socket would not", async () => {
    const ctx = makeCtx();
    const id = crypto.randomUUID();
    // The launch record: what `execLaunch` writes for a runtime pane.
    await ctx.meta.record({
      subshellId: id,
      cwd: "/home/dst/work",
      socket: "subshell-dest",
      harnessId: "terminal",
      name: id,
      startedAt: new Date(1_700_000_000_000).toISOString(),
    });
    const askedSockets: string[] = [];
    ctx.tmux = {
      hasSubshell: async (socket: string, subId: string) => {
        askedSockets.push(socket);
        // Destination truth: the pane exists on the destination socket only.
        return socket === "subshell-dest" && subId === id;
      },
      paneExitCode: async () => null,
      paneTitle: async () => null,
      capturePane: async () => "SCREEN",
    } as unknown as CommandContext["tmux"];
    const result = await runRuntimeCommand(ctx, "subshell-dest", { type: "probe", ref: "r-4", subshellIds: [id] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([{ subshellId: id, alive: true, exitCode: null, capture: "SCREEN" }]);
    expect(askedSockets[0]).toBe("subshell-dest"); // the record, not `subshell-<id>`
  });

  test("an id with no record falls back to the derivation (orphan posture, unchanged)", async () => {
    const ctx = makeCtx();
    const id = crypto.randomUUID();
    const asked: string[] = [];
    ctx.tmux = {
      hasSubshell: async (socket: string) => {
        asked.push(socket);
        return false;
      },
      paneExitCode: async () => null,
    } as unknown as CommandContext["tmux"];
    const result = await runRuntimeCommand(ctx, "subshell-dest", { type: "probe", ref: "r-5", subshellIds: [id] });
    expect(result.ok).toBe(true);
    expect(asked[0]).not.toBe("subshell-dest"); // the fallback derivation
  });
});
