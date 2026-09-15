import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  type NodeRuntimeReport,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";

/**
 * The `update` executor: its refusals, and the ordering of its success.
 *
 * The refusal cases end before the network, deliberately. An update is a
 * restart with a file swap in front of it, so both of `service restart`'s
 * refusals apply and they apply FIRST — a refusal that arrives after 70 MB has
 * crossed the wire is a worse refusal for having been late. Their URLs point
 * at nothing, so a case that ever reached the download would fail loudly
 * rather than pass by accident.
 *
 * The success case runs the whole thing for real against a `Bun.serve`, with
 * nothing stubbed but `process.execPath`. What it is there to pin is the
 * ORDER: `{ ok: true }` is the answer and `requestRestart` follows it, because
 * the daemon is the only sender of `result` and an executor that exited itself
 * would reach the plane as a timeout for an update that worked.
 */

function runtimeReport(over: Partial<NodeRuntimeReport> = {}): NodeRuntimeReport {
  return {
    startedAt: "2026-09-15T00:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/home/t/.config/systemd/user/subshell.service",
      state: "running",
      pid: 42,
      enabled: true,
      linger: true,
      paneSafety: "keeps",
    },
    configPath: "/home/t/.config/subshell/config.json",
    agentLogPath: "/home/t/.config/subshell/logs/agent.log",
    logPath: null,
    logHint: null,
    logging: { debug: false, source: "default" },
    tmuxPath: "/usr/bin/tmux",
    binaryPath: "/home/t/.local/bin/subshell",
    ...over,
  };
}

async function ctxWith(runtime: NodeRuntimeReport | null, onRestart: () => void): Promise<CommandContext> {
  const dataDir = await mkdtemp(join(tmpdir(), "subshell-cmd-update-"));
  return {
    config: {
      serverUrl: "http://localhost:1",
      nodeId: "n",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir,
      name: "t",
    },
    tmux: {} as CommandContext["tmux"],
    meta: {} as CommandContext["meta"],
    nowMs: () => 0,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime,
    requestRestart: onRestart,
  };
}

/** A URL nothing serves — reaching it is the failure these cases are guarding. */
const unreachable = {
  type: "update" as const,
  version: "0.9.9",
  url: "http://127.0.0.1:1/never",
  sha256: "0".repeat(64),
};

describe("execUpdate refusals", () => {
  it("refuses an unsupervised agent, because exiting would be a stop rather than a restart", async () => {
    let restarts = 0;
    const ctx = await ctxWith(runtimeReport({ supervised: false }), () => restarts++);
    expect(await dispatchCommand(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(restarts).toBe(0);
  });

  it("refuses with NO runtime report at all — a missing report is less evidence, not more", async () => {
    // The correction `execService` carries: `runtime &&` used to skip the
    // whole check on exactly the machine that could say least about itself.
    let restarts = 0;
    const ctx = await ctxWith(null, () => restarts++);
    expect(await dispatchCommand(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(restarts).toBe(0);
  });

  it("refuses a definition that would kill live panes, and fails CLOSED on `unknown`", async () => {
    for (const paneSafety of ["kills", "unknown"] as const) {
      const ctx = await ctxWith(
        runtimeReport({ service: { ...runtimeReport().service, paneSafety } }),
        () => undefined,
      );
      expect(await dispatchCommand(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_KILLS_PANES });
    }
  });

  it("maps an applyUpdate refusal onto the WIRE CONSTANT, never a sentence", async () => {
    // The plane matches `NodeRpcError.detail` by equality, so an executor that
    // answered `applyUpdate`'s human message ("this agent is running from a
    // source checkout…") would produce a 500 naming nothing an operator can
    // act on. The refusal this suite gets is NOT_COMPILED because the test
    // runner IS an interpreter running a script — which is the same thing a
    // dev agent under `bun run` reports, and exactly the right answer there.
    const ctx = await ctxWith(runtimeReport(), () => undefined);
    const result = await dispatchCommand(ctx, unreachable);
    expect(result).toEqual({ ok: false, error: NODE_RESULT_NOT_COMPILED });
  });

  it("lets force past the pane refusal but never past the supervision one", async () => {
    // `force` means "act although panes will die". It cannot mean "exit a
    // process nothing will respawn" — that is not a restart at any setting.
    const unsupervised = await ctxWith(runtimeReport({ supervised: false }), () => undefined);
    expect(await dispatchCommand(unsupervised, { ...unreachable, force: true })).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_SUPERVISED,
    });
    const killsPanes = await ctxWith(
      runtimeReport({ service: { ...runtimeReport().service, paneSafety: "kills" } }),
      () => undefined,
    );
    // Past the pane gate, so it reaches `applyUpdate` and fails THERE (this
    // runner is an interpreter, so NOT_COMPILED) rather than at the gate.
    expect(await dispatchCommand(killsPanes, { ...unreachable, force: true })).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_COMPILED,
    });
  });

  it("does not ask the daemon to exit when the update did not happen", async () => {
    // The ordering that makes a plane-driven update legible: `requestRestart`
    // fires only after the swap, so a refused update leaves a live agent on
    // the socket that answered rather than a machine that bounced for nothing.
    let restarts = 0;
    const ctx = await ctxWith(runtimeReport(), () => restarts++);
    await dispatchCommand(ctx, unreachable);
    expect(restarts).toBe(0);
  });
});

describe("execUpdate success", () => {
  it("swaps the binary, answers ok, and ONLY THEN asks the daemon to exit", async () => {
    // The whole plane-driven path, with nothing stubbed but `process.execPath`:
    // a real HTTP server serves the artifact, the digest is real, and the
    // "binary" is a shell script that answers `subshell 0.9.9` — which is what
    // lets the executor's own version probe run for real rather than through a
    // seam this command has no way to inject.
    const root = await mkdtemp(join(tmpdir(), "subshell-cmd-update-ok-"));
    const binary = join(root, "subshell");
    await writeFile(binary, "#!/bin/sh\necho 'subshell 0.8.0 (node protocol v9)'\n");
    await chmod(binary, 0o755);
    const next = "#!/bin/sh\necho 'subshell 0.9.9 (node protocol v10)'\n";
    const server = Bun.serve({ port: 0, fetch: () => new Response(next) });
    const digest = new Bun.CryptoHasher("sha256").update(next).digest("hex");
    const execPathBefore = process.execPath;
    Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });

    let restarts = 0;
    try {
      const ctx = await ctxWith(runtimeReport(), () => restarts++);
      const result = await dispatchCommand(ctx, {
        type: "update",
        version: "0.9.9",
        url: `http://127.0.0.1:${server.port}/agent`,
        sha256: digest,
      });
      expect(result).toEqual({ ok: true });
      // The daemon is the only sender of `result`, so the executor asks for
      // the exit and the daemon defers it — a restart the plane read as a
      // timeout would be a success reported as a failure.
      expect(restarts).toBe(1);
    } finally {
      Object.defineProperty(process, "execPath", { value: execPathBefore, configurable: true, writable: true });
      server.stop(true);
    }
    expect(await readFile(binary, "utf8")).toBe(next);
    expect(await readFile(`${binary}.previous`, "utf8")).toContain("0.8.0");
  });
});
