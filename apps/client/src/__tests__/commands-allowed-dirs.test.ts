import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllowedDirs, writeAllowedDirs } from "../allowed-dirs.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { AgentConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * The allowlist WIRING on the node — `set_allowed_dirs` and the two executors
 * that consult it.
 *
 * `allowed-dirs.test.ts` covers the primitive (persistence, symlink escapes);
 * this covers whether the commands are actually plumbed to it, which is the
 * half that the control plane depends on and that no integration test reaches
 * (it would need a second enrolled machine).
 *
 * Everything goes through `dispatchCommand` rather than the executors
 * directly, so the parser and the switch are exercised too — a command that
 * parses but is never routed would pass an executor-level test.
 */

const made: string[] = [];

function freshDir(): string {
  // realpath'd: on macOS the temp dir is behind /private, and the node's
  // check resolves symlinks — a raw path here would test the wrong thing.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmd-ad-")));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A context with no tmux: every case here is refused before tmux is touched. */
function makeCtx(dataDir: string): CommandContext {
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
    // Deliberately a throwing stub: reaching tmux at all means a refusal did
    // not happen, and the failure should say so rather than pass quietly.
    tmux: new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`tmux must not be reached; called ${String(prop)}`);
        },
      },
    ) as unknown as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => 1_700_000_000_000,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
  };
}

describe("set_allowed_dirs", () => {
  it("persists the pushed set and answers with what was stored", async () => {
    const dataDir = freshDir();
    const res = await dispatchCommand(makeCtx(dataDir), {
      type: "set_allowed_dirs",
      dirs: ["/srv/work/", "/home/theo", "/home/theo/nested"],
    });
    expect(res.ok).toBe(true);
    // Normalized by the node too: it must not trust the wire to be clean.
    expect(res.ok && res.data).toEqual({ dirs: ["/home/theo", "/srv/work"] });
    expect(readAllowedDirs(dataDir)).toEqual(["/home/theo", "/srv/work"]);
  });

  it("an empty push clears the rules — the node returns to unrestricted", async () => {
    const dataDir = freshDir();
    writeAllowedDirs(dataDir, ["/a"]);
    const res = await dispatchCommand(makeCtx(dataDir), { type: "set_allowed_dirs", dirs: [] });
    expect(res.ok).toBe(true);
    expect(readAllowedDirs(dataDir)).toEqual([]);
  });

  it("is idempotent — the reconnect push replays the same set harmlessly", async () => {
    const dataDir = freshDir();
    const ctx = makeCtx(dataDir);
    await dispatchCommand(ctx, { type: "set_allowed_dirs", dirs: ["/a"] });
    await dispatchCommand(ctx, { type: "set_allowed_dirs", dirs: ["/a"] });
    expect(readAllowedDirs(dataDir)).toEqual(["/a"]);
  });
});

describe("launch refusal", () => {
  it("refuses a cwd outside the rules, before touching tmux", async () => {
    const dataDir = freshDir();
    const outside = freshDir();
    writeAllowedDirs(dataDir, [join(dataDir, "work")]);
    mkdirSync(join(dataDir, "work"), { recursive: true });

    const res = await dispatchCommand(makeCtx(dataDir), {
      type: "launch",
      subshellId: "11111111-1111-4111-8111-111111111111",
      socket: "subshell-x",
      cwd: outside,
      harnessId: "claude-code",
      profile: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
      subshellEnv: {},
      subshellName: "s",
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("allowed directories");
  });

  it("refuses a symlink out of an allowed root — the fs-aware check, not the lexical one", async () => {
    const dataDir = freshDir();
    const outside = freshDir();
    const work = join(dataDir, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(outside, "secret"), { recursive: true });
    symlinkSync(join(outside, "secret"), join(work, "escape"));
    writeAllowedDirs(dataDir, [work]);

    const res = await dispatchCommand(makeCtx(dataDir), {
      type: "launch",
      subshellId: "11111111-1111-4111-8111-111111111111",
      socket: "subshell-x",
      cwd: join(work, "escape"),
      harnessId: "claude-code",
      profile: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
      subshellEnv: {},
      subshellName: "s",
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("allowed directories");
  });
});

describe("stat_dir refusal", () => {
  it("refuses a directory outside the rules, so the pre-launch probe agrees with launch", async () => {
    const dataDir = freshDir();
    const outside = freshDir();
    mkdirSync(join(dataDir, "work"), { recursive: true });
    writeAllowedDirs(dataDir, [join(dataDir, "work")]);

    const res = await dispatchCommand(makeCtx(dataDir), { type: "stat_dir", path: outside });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("allowed directories");
  });

  it("allows a directory inside the rules", async () => {
    const dataDir = freshDir();
    const work = join(dataDir, "work");
    mkdirSync(join(work, "deep"), { recursive: true });
    writeAllowedDirs(dataDir, [work]);

    const res = await dispatchCommand(makeCtx(dataDir), { type: "stat_dir", path: join(work, "deep") });
    expect(res.ok).toBe(true);
  });

  it("is unaffected with no rules — the backwards-compatible default", async () => {
    const dataDir = freshDir();
    const anywhere = freshDir();
    const res = await dispatchCommand(makeCtx(dataDir), { type: "stat_dir", path: anywhere });
    expect(res.ok).toBe(true);
  });
});

describe("fs_ls is deliberately NOT gated", () => {
  it("lists a directory outside the rules — browsing is not launching", async () => {
    // Gating this made the SECOND allowlist rule unaddable: the owner browses
    // through this command to choose what to permit, so the first rule hid
    // everywhere else. The control plane filters listings instead, where it
    // knows whether the caller is picking a working directory or defining the
    // rules. See the spec's 2026-09-05 revision note.
    const dataDir = freshDir();
    const outside = freshDir();
    mkdirSync(join(outside, "child"), { recursive: true });
    writeAllowedDirs(dataDir, [join(dataDir, "work")]);

    const res = await dispatchCommand(makeCtx(dataDir), { type: "fs_ls", path: outside });
    expect(res.ok).toBe(true);
  });
});
