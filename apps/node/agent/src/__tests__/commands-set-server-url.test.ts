import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { AgentConfig } from "../config.js";
import { configPath, saveConfig } from "../config.js";

/**
 * `set_server_url` writes the real `config.json`, so every case here points
 * `SUBSHELL_CONFIG_HOME` at its own throwaway directory. The preload already
 * keeps the suite away from `~/.config/subshell`; this keeps the cases away
 * from each other.
 */
function isolate(): void {
  process.env.SUBSHELL_CONFIG_HOME = mkdtempSync(join(tmpdir(), "subshell-repoint-"));
}

const ENROLLED: AgentConfig = {
  serverUrl: "https://old.example.com",
  nodeId: "node-1",
  nodeKey: "nsk_secret",
  controlPublicKey: '{"kty":"OKP"}',
  dataDir: "/tmp/data",
  name: "laptop",
  nodeWsUrl: "wss://old.example.com/ws/node",
};

function ctx(): CommandContext {
  return {
    config: ENROLLED,
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

describe("set_server_url", () => {
  it("rewrites the address and keeps the identity", async () => {
    isolate();
    await saveConfig(ENROLLED);
    const res = await dispatchCommand(ctx(), { type: "set_server_url", url: "https://new.example.com" });
    expect(res).toEqual({ ok: true, data: "https://new.example.com" });

    const written = JSON.parse(await readFile(configPath(), "utf8")) as AgentConfig;
    expect(written.serverUrl).toBe("https://new.example.com");
    // The identity is the whole reason this is not an enroll: the node key's
    // only home is this file, and the plane still has to see the same node.
    expect(written.nodeId).toBe("node-1");
    expect(written.nodeKey).toBe("nsk_secret");
    expect(written.controlPublicKey).toBe('{"kty":"OKP"}');
  });

  // `nodeWsUrl` is what the OLD plane said about itself, and `resolveWsUrl`
  // PREFERS it over any derivation — so carrying it forward would leave the
  // daemon dialing the old host while `serverUrl` named the new one.
  it("clears the enroll-time ws url so the daemon stops dialing the old host", async () => {
    isolate();
    await saveConfig(ENROLLED);
    await dispatchCommand(ctx(), { type: "set_server_url", url: "https://new.example.com" });
    const written = JSON.parse(await readFile(configPath(), "utf8")) as AgentConfig;
    expect(written.nodeWsUrl).toBeUndefined();
  });

  // Validated BEFORE the file is read, so a refusal leaves it byte-identical.
  // That file holds the only copy of the node key.
  it("refuses an unusable address without touching the file", async () => {
    isolate();
    await saveConfig(ENROLLED);
    const before = await readFile(configPath(), "utf8");
    const res = await dispatchCommand(ctx(), { type: "set_server_url", url: "not a url" });
    expect(res.ok).toBe(false);
    expect(await readFile(configPath(), "utf8")).toBe(before);
  });

  // The result carries the address, never the key — the same rule `enroll
  // --json` and `status --json` follow.
  it("never answers with the node key", async () => {
    isolate();
    await saveConfig(ENROLLED);
    const res = await dispatchCommand(ctx(), { type: "set_server_url", url: "https://new.example.com" });
    expect(JSON.stringify(res)).not.toContain("nsk_secret");
  });
});
