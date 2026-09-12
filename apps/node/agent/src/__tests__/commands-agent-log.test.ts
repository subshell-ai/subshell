import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { AGENT_LOG_CAP_BYTES, agentLogPath } from "../log-file.js";

/** Point the config home at a throwaway dir and write a log file inside it. */
function withLog(text: string): string {
  process.env.SUBSHELL_CONFIG_HOME = mkdtempSync(join(tmpdir(), "subshell-agentlog-"));
  const path = agentLogPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function ctx(): CommandContext {
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
    runtime: null,
    requestRestart: () => {},
  };
}

describe("agent_log_read", () => {
  it("reads a range and says where to continue", async () => {
    withLog("abcdefghij");
    const res = await dispatchCommand(ctx(), { type: "agent_log_read", fromByte: 0, maxBytes: 4 });
    expect(res).toEqual({ ok: true, data: { text: "abcd", nextByte: 4, size: 10, truncated: false } });
  });

  it("is empty rather than an error on a machine that has logged nothing", async () => {
    process.env.SUBSHELL_CONFIG_HOME = mkdtempSync(join(tmpdir(), "subshell-agentlog-"));
    const res = await dispatchCommand(ctx(), { type: "agent_log_read", fromByte: 0, maxBytes: 100 });
    expect(res).toEqual({ ok: true, data: { text: "", nextByte: 0, size: 0, truncated: false } });
  });

  // The caller's cap is not the only one. A frame carrying more than the file
  // can hold would be a frame built from a number the plane chose.
  it("clamps the caller's maxBytes to the file's own cap", async () => {
    withLog("x".repeat(1000));
    const res = await dispatchCommand(ctx(), {
      type: "agent_log_read",
      fromByte: 0,
      maxBytes: AGENT_LOG_CAP_BYTES * 100,
    });
    expect(res.ok).toBe(true);
    const data = res.ok === true ? (res.data as { text: string }) : { text: "" };
    expect(data.text.length).toBe(1000);
  });
});
