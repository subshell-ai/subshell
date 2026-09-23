import { describe, expect, it } from "bun:test";
import { configPath } from "../config.js";
import { type DaemonLock, lockPath } from "../lock.js";
import type { SubshellMeta } from "../subshell-meta.js";
import { runUnenroll, type UnenrollDeps } from "../unenroll-cli.js";

/**
 * `subshell unenroll` — the narrow deregistration beside the client's reset
 * chain. What these pins own, in order of the harm each prevents:
 *
 * 1. the DELETION SET and its ORDER (lock first, config LAST, nothing else),
 * 2. the two REFUSALS (live daemon, live panes) — exit 1, text even under
 *    `--json`, and nothing deleted on the way out,
 * 3. the census's fail-closed rule (an unanswerable tmux PROPAGATES), and
 * 4. the success VIEW's honesty: kept data dir, kept-but-warned definition,
 *    kept plane row.
 */

function cfg(over: Partial<import("../config.js").NodeConfig> = {}): import("../config.js").NodeConfig {
  return {
    serverUrl: "https://plane.example",
    nodeId: "node-abc",
    nodeKey: "nsk_secret",
    controlPublicKey: "pk",
    dataDir: "/home/u/.local/share/subshell",
    name: "workstation",
    ...over,
  };
}

const LOCK: DaemonLock = {
  pid: 4242,
  startedAt: "2026-09-22T00:00:00.000Z",
  nodeId: "node-abc",
  lastTickAt: "2026-09-22T00:00:15.000Z",
};

const META: SubshellMeta = {
  subshellId: "sub-1",
  socket: "/tmp/tmux-sock",
  name: "build runner",
  cwd: "/home/u/project",
} as SubshellMeta;

function fake(over: Partial<UnenrollDeps> = {}): { deps: UnenrollDeps; removed: string[] } {
  const removed: string[] = [];
  const deps: UnenrollDeps = {
    tmux: { hasSubshell: async () => false },
    meta: { list: async () => [] },
    readLock: () => null,
    isPidAlive: () => false,
    fileExists: async (p) => p === lockPath(),
    removeFile: async (p) => {
      removed.push(p);
    },
    ...over,
  };
  return { deps, removed };
}

describe("refusals", () => {
  it("refuses a live daemon, names both stop routes, and deletes nothing", async () => {
    const { deps, removed } = fake({ readLock: () => LOCK, isPidAlive: () => true });
    const r = await runUnenroll(cfg(), { yes: false, json: false }, deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("daemon is running (pid 4242)");
    expect(r.err).toContain("subshell service stop");
    expect(r.err).toContain("subshell run");
    expect(removed).toEqual([]);
  });

  // The merged-wave review measured what `--yes` used to buy here: a live
  // daemon with no service definition walked the client's absence-tolerant
  // chain to this verb, the flag skipped the refusal, and the "removed"
  // report covered a machine whose daemon was still dialing the plane with
  // the deleted config in memory. A daemon that has not stopped is not a
  // consentable orphan — the flag waives PANES, never this.
  it("refuses a live daemon EVEN WITH --yes", async () => {
    const { deps, removed } = fake({ readLock: () => LOCK, isPidAlive: () => true });
    const r = await runUnenroll(cfg(), { yes: true, json: false }, deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("will not unenroll itself");
    expect(removed).toEqual([]);
  });

  it("refuses in TEXT even under --json, because the exit code is the contract", async () => {
    const { deps } = fake({ readLock: () => LOCK, isPidAlive: () => true });
    const r = await runUnenroll(cfg(), { yes: false, json: true }, deps);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(() => JSON.parse(r.out)).toThrow();
  });

  it("refuses with live panes listed, and --yes is what accepts the orphaning", async () => {
    const { deps, removed } = fake({ meta: { list: async () => [META] }, tmux: { hasSubshell: async () => true } });
    const r = await runUnenroll(cfg(), { yes: false, json: false }, deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("1 running subshell would keep running");
    expect(r.err).toContain("build runner · sub-1 · /home/u/project");
    expect(removed).toEqual([]);

    const ok = await runUnenroll(cfg(), { yes: true, json: false }, deps);
    expect(ok.code).toBe(0);
    expect(removed).toContain(configPath());
  });

  it("propagates an unanswerable tmux rather than reading it as 'nothing running'", async () => {
    const { deps } = fake({
      meta: { list: async () => [META] },
      tmux: {
        hasSubshell: async () => {
          throw new Error("no server running on /tmp/tmux-501/default");
        },
      },
    });
    await expect(runUnenroll(cfg(), { yes: false, json: false }, deps)).rejects.toThrow("no server running");
  });

  it("treats a stale lock (dead pid) as no daemon at all", async () => {
    const { deps, removed } = fake({ readLock: () => LOCK, isPidAlive: () => false });
    const r = await runUnenroll(cfg(), { yes: false, json: false }, deps);
    expect(r.code).toBe(0);
    expect(removed).toEqual([lockPath(), configPath()]);
  });

  // `status`'s rule for the same file: a lock naming ANOTHER node in this
  // config home is never trusted and never deleted — that daemon, dead or
  // alive, belongs to someone else's un-enroll. The JSON says `kept` rather
  // than the softer `absent`, because the file IS there.
  it("leaves another node's lock standing and says kept", async () => {
    const foreign = { ...LOCK, nodeId: "node-other" };
    const { deps, removed } = fake({ readLock: () => foreign, isPidAlive: () => false });
    const r = await runUnenroll(cfg(), { yes: false, json: true }, deps);
    expect(r.code).toBe(0);
    expect(removed).toEqual([configPath()]);
    expect(JSON.parse(r.out).lockFile).toBe("kept");
  });
});

describe("the deletion", () => {
  it("removes the lock FIRST and the config LAST — the reset chain's resumability rule", async () => {
    const { deps, removed } = fake();
    const r = await runUnenroll(cfg(), { yes: false, json: false }, deps);
    expect(r.code).toBe(0);
    expect(removed).toEqual([lockPath(), configPath()]);
  });

  it("deletes nothing else: the data dir and the binary are not in the set", async () => {
    const { deps, removed } = fake();
    await runUnenroll(cfg(), { yes: false, json: true }, deps);
    expect(removed.every((p) => !p.startsWith(cfg().dataDir))).toBe(true);
    expect(removed).toEqual([lockPath(), configPath()]);
  });

  it("says an absent lock is absent, in both views", async () => {
    const { deps } = fake({ fileExists: async () => false });
    const j = await runUnenroll(cfg(), { yes: false, json: true }, deps);
    expect(JSON.parse(j.out).lockFile).toBe("absent");
    const t = await runUnenroll(cfg(), { yes: false, json: false }, fake({ fileExists: async () => false }).deps);
    expect(t.out).not.toContain(lockPath());
  });

  it("the success text keeps its three honest sentences", async () => {
    const { deps } = fake();
    const r = await runUnenroll(cfg(), { yes: false, json: false }, deps);
    // The data dir stays, the definition respawns if kept, the row stays.
    expect(r.out).toContain(`the data directory is kept at ${cfg().dataDir}`);
    expect(r.out).toContain("subshell service uninstall");
    expect(r.out).toContain("until its owner deletes the row there");
  });

  it("--json answers the exact shape the client will read", async () => {
    const { deps } = fake();
    const r = await runUnenroll(cfg(), { yes: false, json: true }, deps);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      nodeId: "node-abc",
      name: "workstation",
      configFile: "removed",
      lockFile: "removed",
      dataDir: "/home/u/.local/share/subshell",
    });
  });
});
