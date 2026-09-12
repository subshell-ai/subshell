import { describe, expect, it } from "bun:test";
import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NOT_SUPERVISED,
  type NodeRuntimeReport,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";

function ctxWith(runtime: NodeRuntimeReport | null, onRestart: () => void): CommandContext {
  return {
    config: {
      serverUrl: "http://localhost:1",
      nodeId: "n",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir: "/tmp/x",
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

const supervised: NodeRuntimeReport = {
  startedAt: "2026-09-12T00:00:00.000Z",
  supervised: true,
  service: {
    manager: "systemd",
    installed: true,
    definitionPath: "/x",
    state: "running",
    pid: 1,
    enabled: true,
    paneSafety: "keeps",
  },
  configPath: "/c",
  logPath: null,
  logHint: "j",
  tmuxPath: null,
  binaryPath: "/b",
};

describe("restart", () => {
  it("refuses when not supervised and asks for no exit", async () => {
    let asked = 0;
    const res = await dispatchCommand(
      ctxWith({ ...supervised, supervised: false }, () => asked++),
      {
        type: "restart",
      },
    );
    expect(res).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(asked).toBe(0);
  });

  it("refuses a pane-killing definition without force, accepts with force", async () => {
    let asked = 0;
    const kills = { ...supervised, service: { ...supervised.service, paneSafety: "kills" as const } };
    expect(
      await dispatchCommand(
        ctxWith(kills, () => asked++),
        { type: "restart" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_KILLS_PANES,
    });
    expect(
      await dispatchCommand(
        ctxWith(kills, () => asked++),
        { type: "restart", force: true },
      ),
    ).toEqual({
      ok: true,
    });
    expect(asked).toBe(1);
  });

  it("refuses an unknown paneSafety without force — the same fail-closed rule the CLI uses", async () => {
    const unknown = { ...supervised, service: { ...supervised.service, paneSafety: "unknown" as const } };
    expect(
      await dispatchCommand(
        ctxWith(unknown, () => {}),
        { type: "restart" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_KILLS_PANES,
    });
  });

  it("accepts when supervised and pane-safe, and asks the daemon to exit", async () => {
    let asked = 0;
    expect(
      await dispatchCommand(
        ctxWith(supervised, () => asked++),
        { type: "restart" },
      ),
    ).toEqual({ ok: true });
    expect(asked).toBe(1);
  });

  it("refuses when no runtime was collected", async () => {
    expect(
      await dispatchCommand(
        ctxWith(null, () => {}),
        { type: "restart" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_SUPERVISED,
    });
  });
});
