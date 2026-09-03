import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentConfig, clientHome, configPath, loadConfig, saveConfig } from "../config.js";
import { newHome } from "../test-preload.js";

const sample: AgentConfig = {
  serverUrl: "http://localhost:4000",
  nodeId: "node_123",
  nodeKey: "subshell_secret_never_printed",
  controlPublicKey: '{"kty":"EC","crv":"P-256"}',
  dataDir: "/tmp/somewhere",
  name: "workstation",
};

test("saveConfig → loadConfig round-trip with 0600 file and 0700 dir", async () => {
  newHome();
  await saveConfig(sample);
  expect(await loadConfig()).toEqual(sample);
  // Unconditional mode assert: every supported target is POSIX (spec §8 — the
  // agent ships macos/linux only), and bun:test runs on the dev host anyway.
  expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(configPath())).mode & 0o777).toBe(0o700);
});

test("saveConfig re-applies the mode when umask interfered", async () => {
  newHome();
  await saveConfig(sample);
  // Simulate a permissive umask having widened the file: save must re-tighten.
  writeFileSync(configPath(), JSON.stringify({ ...sample, name: "second" }));
  chmodSync(configPath(), 0o644);
  await saveConfig({ ...sample, name: "second" });
  expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  expect((await loadConfig()).name).toBe("second");
});

test("nodeWsUrl round-trips when present; an old config loads without it (ledger 17c)", async () => {
  newHome();
  // Enroll now persists the server-reported ws URL; load must hand it back verbatim.
  const pinned = { ...sample, nodeWsUrl: "wss://subshell.example/ws/node" };
  await saveConfig(pinned);
  expect(await loadConfig()).toEqual(pinned);
  // Old config on disk (no nodeWsUrl): tolerated — the field is simply absent and
  // the daemon falls back to the derived URL.
  writeFileSync(configPath(), JSON.stringify(sample));
  const old = await loadConfig();
  expect(old.nodeWsUrl).toBeUndefined();
  expect(old).toEqual(sample);
});

test("a hand-edited empty/blank nodeWsUrl is junk → absent, so resolveWsUrl derives (never dials '')", async () => {
  newHome();
  // enroll only persists a non-empty server answer, so "" on disk is a
  // hand-edit; the daemon's `??` would otherwise pin an empty dial target.
  writeFileSync(configPath(), JSON.stringify({ ...sample, nodeWsUrl: "" }));
  const empty = await loadConfig();
  expect(empty.nodeWsUrl).toBeUndefined();
  expect(empty).toEqual(sample);
  // Whitespace-only is the same junk class.
  writeFileSync(configPath(), JSON.stringify({ ...sample, nodeWsUrl: "   " }));
  expect((await loadConfig()).nodeWsUrl).toBeUndefined();
  // A non-string value was always junk-tolerated the same way — unchanged.
  writeFileSync(configPath(), JSON.stringify({ ...sample, nodeWsUrl: 42 }));
  expect((await loadConfig()).nodeWsUrl).toBeUndefined();
});

test("loadConfig throws an actionable error when no config exists", async () => {
  newHome();
  await expect(loadConfig()).rejects.toThrow(/enroll/);
});

test("loadConfig reports corruption as corrupt, not missing", async () => {
  newHome();
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), "{ not json");
  await expect(loadConfig()).rejects.toThrow(/corrupt/);
});

test("loadConfig rejects a JSON file that is not a usable config object", async () => {
  newHome();
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ serverUrl: "http://x" }));
  await expect(loadConfig()).rejects.toThrow(/corrupt/);
});

describe("clientHome", () => {
  test("defaults to ~/.config/subshell with no env override", () => {
    delete process.env.SUBSHELL_CONFIG_HOME;
    // homedir() is host truth; assert the tail, not the whole path.
    expect(clientHome().endsWith(join(".config", "subshell"))).toBe(true);
    process.env.SUBSHELL_CONFIG_HOME = newHome();
  });

  test("SUBSHELL_CONFIG_HOME overrides the default", () => {
    const dir = newHome();
    process.env.SUBSHELL_CONFIG_HOME = dir;
    expect(clientHome()).toBe(dir);
  });
});
