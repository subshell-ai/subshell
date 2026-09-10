import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeFsLsResult } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { AgentConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * `fs_ls` under the dispatcher — the remote folder picker's
 * agent side. Every success answer is additionally run through the shared
 * `parseNodeFsLsResult` contract so the agent can never drift from what the
 * control plane's pass-through expects. The semantics under test are the
 * LOCAL `GET /api/files/explore` rules mirrored node-side: absolute-only,
 * dotfiles hidden, one level, directories only, capped.
 */

let base: string;
let dataDir: string;
let root: string; // the browse root for most cases

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-fsls-")));
  dataDir = join(base, "data");
  root = join(base, "root");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "alpha"), { recursive: true });
  mkdirSync(join(root, "beta"), { recursive: true });
  mkdirSync(join(root, ".hidden-dir"), { recursive: true });
  writeFileSync(join(root, "plain.txt"), "file");
  writeFileSync(join(root, ".hidden.txt"), "dotfile");
  symlinkSync(join(root, "alpha"), join(root, "link-dir"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Minimal context — fs_ls touches none of it (no tmux, no meta, no socket). */
function makeCtx(): CommandContext {
  const config: AgentConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
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
  };
}

async function fsLs(path: string) {
  return await dispatchCommand(makeCtx(), { type: "fs_ls", path });
}

/** fs_ls over `path`, asserted ok:true + contract-valid, narrowed. */
async function lsOk(path: string) {
  const res = await fsLs(path);
  if (!res.ok) throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
  const parsed = parseNodeFsLsResult(res.data);
  expect(parsed).not.toBeNull();
  if (!parsed) throw new Error("unreachable");
  return parsed;
}

describe("fs_ls (remote folder picker)", () => {
  it("lists ONE level of directories only: dotfiles hidden, files excluded, symlinked dirs followed", async () => {
    const r = await lsOk(root);
    expect(r.path).toBe(root);
    expect(r.parent).toBe(base); // join(root, "..") — the local route's parent rule
    expect(r.entries.map((e) => e.name).sort()).toEqual(["alpha", "beta", "link-dir"]);
    expect(r.entries.every((e) => e.kind === "dir")).toBe(true);
    expect(r.entries.find((e) => e.name === "alpha")?.path).toBe(join(root, "alpha"));
    expect(r.truncated).toBe(false);
  });

  it("empty path lists the AGENT's home (the server cannot expand ~ for a machine it cannot see)", async () => {
    const r = await lsOk("");
    expect(r.path).toBe(realpathSync(homedir()));
  });

  it("the filesystem root has parent null; anywhere else has a parent", async () => {
    const atRoot = await lsOk("/");
    expect(atRoot.parent).toBeNull();
  });

  it("a target that exists but is not a directory answers an empty listing (local-route parity)", async () => {
    const r = await lsOk(join(root, "plain.txt"));
    expect(r.entries).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("absolute-only, no `..` segments — relatives, ~ spellings, and traversal answer EINVAL", async () => {
    for (const bad of ["relative/dir", "~/projects", "../escape", "/root/../etc", "/root/..", "~"]) {
      const res = await fsLs(bad);
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.error.startsWith("EINVAL:"), `${bad} → ${res.error}`).toBe(true);
    }
  });

  it("a missing directory answers ENOENT (the server maps it to the picker's 404)", async () => {
    const res = await fsLs(join(root, "ghost"));
    expect(res).toEqual({ ok: false, error: `ENOENT: ${join(root, "ghost")}` });
  });

  it("an unreadable directory answers EACCES, not a throw", async () => {
    // Root ignores mode bits — the scenario does not exist under a root uid.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const locked = join(base, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const res = await fsLs(locked);
      expect(res).toEqual({ ok: false, error: `EACCES: ${locked}` });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("caps the listing at 1000 entries and flags truncation", async () => {
    const many = join(base, "many");
    mkdirSync(many);
    for (let i = 0; i < 1001; i++) mkdirSync(join(many, `d${String(i).padStart(4, "0")}`));
    const r = await lsOk(many);
    expect(r.entries).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it("a below-cap directory has no truncation flag even with 999 dirs", async () => {
    const justUnder = join(base, "just-under");
    mkdirSync(justUnder);
    for (let i = 0; i < 999; i++) mkdirSync(join(justUnder, `d${String(i).padStart(3, "0")}`));
    const r = await lsOk(justUnder);
    expect(r.entries).toHaveLength(999);
    expect(r.truncated).toBe(false);
  });
});
