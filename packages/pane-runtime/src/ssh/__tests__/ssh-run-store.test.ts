import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { reconcileUnsupervisedRuns, sweepCompletedRuns, sweepSshTerminalState } from "../ssh-retention.js";
import {
  acceptRun,
  assertSshRunPath,
  buildRunFacts,
  ensureSshDirs,
  evictCompletedOutput,
  listRunIds,
  openRunStreamAppend,
  readRun,
  readRunStreamWindow,
  removeRunDir,
  runStreamPath,
  runStreamSize,
  type SshRunState,
  sshRunsStorageBytes,
  writeRunState,
} from "../ssh-run-store.js";
import { cleanup, makeDigest, makeRunId, tempRoot } from "./helpers.js";

/**
 * Storage hygiene (SSH-SUPPORT.md §3 "Durable dispatch and storage"): opaque
 * ids as names, 0700 dirs, 0600 files, symlinks refused at create/read/
 * cleanup, dedup that survives output deletion, and the retention sweep on a
 * fake clock. The supervisor's own behavior is covered separately; this is
 * the floor every one of those promises stands on.
 */

let root: string;
let dataDir: string;

beforeAll(() => {
  root = tempRoot("subshell-ssh-store-");
  dataDir = join(root, "data");
  mkdirSync(dataDir);
});

afterAll(() => cleanup(root));

const req = (n: number, digestSeed = "same") => ({
  runId: makeRunId(n),
  requestDigest: makeDigest(digestSeed),
  command: "echo hi",
  remoteDir: null,
  deadlineMs: 60_000,
  snapshotConfigText: "Host *\n  BatchMode yes\n",
});

function completeState(runId: string, overrides: Partial<SshRunState> = {}): SshRunState {
  return {
    runId,
    lifecycle: "completed",
    cancelRequested: false,
    cancelLocalConfirmed: false,
    deadlineHit: false,
    remoteStatus: 0,
    remoteStatusConfirmed: true,
    localExitCode: 0,
    localExitSignal: null,
    startedAtMs: 1,
    finishedAtMs: 2,
    outputEvicted: false,
    spawned: true,
    ...overrides,
  };
}

function seedOutput(runId: string, stream: "stdout" | "stderr", bytes: number): void {
  const fd = openRunStreamAppend(dataDir, runId, stream);
  writeSync(fd, Buffer.alloc(bytes, 7));
  closeSync(fd);
}

describe("path guard", () => {
  it("refuses ids outside the plane's minted grammar", () => {
    for (const bad of ["../evil", "a/b", "with\\backslash", `${"0".repeat(65)}`, "", "."]) {
      expect(() => assertSshRunPath(dataDir, bad)).toThrow("invalid ssh run id");
    }
    expect(() => assertSshRunPath(dataDir, makeRunId(1))).not.toThrow();
  });

  it("readRun answers null (the run_unknown branch) for an uncomposable id instead of throwing", () => {
    expect(readRun(dataDir, "../escape")).toBeNull();
  });
});

describe("acceptance and dedup", () => {
  it("fresh id lands accept.json + state + config with 0700/0600 modes", () => {
    const r = req(101);
    const out = acceptRun(dataDir, r, 1_000);
    expect(out.kind).toBe("accepted");
    const dir = assertSshRunPath(dataDir, r.runId);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dir, "accept.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(dir, "state.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "config"), "utf8")).toContain("BatchMode yes");
    const rec = readRun(dataDir, r.runId);
    expect(rec?.state.lifecycle).toBe("accepted");
    expect(rec?.state.spawned).toBe(false);
  });

  it("same id + same digest is a duplicate carrying the existing state; NOTHING was spawned twice", () => {
    const out = acceptRun(dataDir, req(101), 2_000);
    expect(out.kind).toBe("duplicate");
    if (out.kind === "duplicate") expect(out.state.lifecycle).toBe("accepted");
  });

  it("same id + different digest is the conflict refusal; the earlier request stands", () => {
    const conflict = acceptRun(dataDir, req(101, "different"), 3_000);
    expect(conflict.kind).toBe("conflict");
    expect(readRun(dataDir, makeRunId(101))?.acceptance.acceptedAtMs).toBe(1_000);
  });

  it("evicted output never deletes replay protection (a later duplicate still finds the acceptance)", () => {
    const r = req(102);
    acceptRun(dataDir, r, 1_000);
    seedOutput(r.runId, "stdout", 256);
    writeRunState(dataDir, completeState(r.runId, { finishedAtMs: 1_000 }));
    evictCompletedOutput(dataDir, 1, 2_000);
    expect(runStreamSize(dataDir, r.runId, "stdout")).toBe(0);
    const dup = acceptRun(dataDir, req(102), 3_000);
    expect(dup.kind).toBe("duplicate");
    if (dup.kind === "duplicate") expect(dup.state.outputEvicted).toBe(true);
  });

  it("a stateless orphan (crash between the two writes) recovers honestly with rewritten state", () => {
    const r = req(103);
    acceptRun(dataDir, r, 1_000);
    unlinkSync(join(assertSshRunPath(dataDir, r.runId), "state.json"));
    const out = acceptRun(dataDir, r, 2_000);
    expect(out.kind).toBe("accepted"); // the same request, re-accepted, no new acceptance file
    expect(readRun(dataDir, r.runId)?.state.lifecycle).toBe("accepted");
    expect(readRun(dataDir, r.runId)?.acceptance.acceptedAtMs).toBe(1_000);
  });
});

describe("streams and symlinks", () => {
  it("open refuses a symlink planted at the stream name, read refuses to follow it", () => {
    const r = req(104);
    acceptRun(dataDir, r, 1_000);
    const outside = join(root, "outside-target.txt");
    writeFileSync(outside, "victim");
    symlinkSync(outside, runStreamPath(dataDir, r.runId, "stdout"));
    expect(() => openRunStreamAppend(dataDir, r.runId, "stdout")).toThrow();
    const win = readRunStreamWindow(dataDir, r.runId, "stdout", 0, 100);
    expect(win.bytes.byteLength).toBe(0);
    expect(win.total).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("victim");
  });

  it("read windows honor offsets and caps, and report honest totals", () => {
    const r = req(105);
    acceptRun(dataDir, r, 1_000);
    const fd = openRunStreamAppend(dataDir, r.runId, "stdout");
    writeSync(fd, Buffer.from("hello world"));
    closeSync(fd);
    const w1 = readRunStreamWindow(dataDir, r.runId, "stdout", 0, 5);
    expect(w1.bytes.toString()).toBe("hello");
    const w2 = readRunStreamWindow(dataDir, r.runId, "stdout", 5, 1000);
    expect(w2.bytes.toString()).toBe(" world");
    expect(w2.total).toBe(11);
    const past = readRunStreamWindow(dataDir, r.runId, "stdout", 99, 10);
    expect(past.bytes.byteLength).toBe(0);
    expect(past.total).toBe(11);
  });

  it("acceptRun refuses a symlink occupying the run-dir name", () => {
    const victim = join(root, "victim-run");
    mkdirSync(victim);
    const r = req(120);
    symlinkSync(victim, assertSshRunPath(dataDir, r.runId));
    expect(() => acceptRun(dataDir, r, 1_000)).toThrow("occupied");
    expect(lstatSync(victim).isDirectory()).toBe(true);
  });
});

describe("quota-visible accounting, eviction, retention", () => {
  it("sshRunsStorageBytes sums our records and outputs", () => {
    const r = req(106);
    acceptRun(dataDir, r, 1_000);
    seedOutput(r.runId, "stdout", 1024);
    expect(sshRunsStorageBytes(dataDir)).toBeGreaterThanOrEqual(1024 + 64);
  });

  it("eviction frees the OLDEST completed output first and never touches a running run", () => {
    const oldRun = req(107);
    const newRun = req(108);
    const liveRun = req(109);
    acceptRun(dataDir, oldRun, 1_000);
    acceptRun(dataDir, newRun, 1_000);
    acceptRun(dataDir, liveRun, 1_000);
    seedOutput(oldRun.runId, "stdout", 512);
    seedOutput(newRun.runId, "stdout", 512);
    seedOutput(liveRun.runId, "stdout", 512);
    writeRunState(dataDir, completeState(oldRun.runId, { finishedAtMs: 2_000 }));
    writeRunState(dataDir, completeState(newRun.runId, { finishedAtMs: 9_000 }));
    writeRunState(dataDir, { ...completeState(liveRun.runId), lifecycle: "running", finishedAtMs: null });

    const freed = evictCompletedOutput(dataDir, 512, 10_000);
    expect(freed).toBe(512);
    expect(runStreamSize(dataDir, oldRun.runId, "stdout")).toBe(0); // oldest first
    expect(runStreamSize(dataDir, newRun.runId, "stdout")).toBe(512); // freed target already met
    expect(runStreamSize(dataDir, liveRun.runId, "stdout")).toBe(512); // running: never
  });

  it("retention deletes whole subtrees past the window and keeps fresh, running, and unreadable ones", () => {
    const aged = req(110);
    const fresh = req(111);
    const running = req(112);
    acceptRun(dataDir, aged, 1_000);
    acceptRun(dataDir, fresh, 1_000);
    acceptRun(dataDir, running, 1_000);
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const now = 800_000_000;
    writeRunState(dataDir, completeState(aged.runId, { finishedAtMs: now - windowMs - 1 }));
    writeRunState(dataDir, completeState(fresh.runId, { finishedAtMs: now }));
    writeRunState(dataDir, { ...completeState(running.runId), lifecycle: "running", finishedAtMs: null });
    const out = sweepCompletedRuns(dataDir, now + 1);
    expect(out.deleted).toBeGreaterThanOrEqual(1); // earlier fixtures contribute their own aged completed records
    expect(readRun(dataDir, aged.runId)).toBeNull();
    expect(readRun(dataDir, fresh.runId)).not.toBeNull();
    expect(readRun(dataDir, running.runId)).not.toBeNull();
  });

  it("reconcile marks unsupervised accepted/running records unknown, never restarts them", () => {
    const orphan = req(113);
    acceptRun(dataDir, orphan, 1_000);
    const changed = reconcileUnsupervisedRuns(dataDir, new Set(), 5_000);
    expect(changed.map((f) => f.runId)).toContain(orphan.runId);
    const rec = readRun(dataDir, orphan.runId);
    expect(rec?.state.lifecycle).toBe("unknown");
    expect(rec?.state.finishedAtMs).toBe(5_000);
    // and the changed one is left alone by a SECOND reconcile (unknown is terminal)
    expect(reconcileUnsupervisedRuns(dataDir, new Set(), 6_000).map((f) => f.runId)).not.toContain(orphan.runId);
  });

  it("removeRunDir unlinks a planted symlink at the run name without following it", () => {
    const victim = join(root, "victim-dir");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep"), "x");
    const dir = assertSshRunPath(dataDir, makeRunId(114));
    symlinkSync(victim, dir);
    removeRunDir(dataDir, makeRunId(114));
    expect(existsSync(join(victim, "keep"))).toBe(true); // the target survives
    expect(() => lstatSync(dir)).toThrow(); // the LINK is gone
  });
});

describe("terminal state sweep", () => {
  it("deletes stale terminal state only when the caller's probe says the pane is dead", () => {
    const deadId = makeRunId(115);
    const liveId = makeRunId(116);
    mkdirSync(join(dataDir, "ssh", "terminals"), { recursive: true });
    const stamp = 1_000;
    for (const id of [deadId, liveId]) {
      const p = join(dataDir, "ssh", "terminals", `${id}.json`);
      writeFileSync(p, JSON.stringify({ mode: "agent", generation: 1, logGeneration: 1 }));
      utimesSync(p, new Date(stamp), new Date(stamp));
    }
    const now = stamp + 7 * 24 * 60 * 60 * 1000 + 1;
    const out = sweepSshTerminalState(dataDir, now, { isPaneLive: (id) => id === liveId });
    expect(out.deleted).toBe(1);
    expect(existsSync(join(dataDir, "ssh", "terminals", `${deadId}.json`))).toBe(false);
    expect(existsSync(join(dataDir, "ssh", "terminals", `${liveId}.json`))).toBe(true);
  });

  it("a throwing liveness probe counts as LIVE (unknown is not dead)", () => {
    const id = makeRunId(117);
    const p = join(dataDir, "ssh", "terminals", `${id}.json`);
    writeFileSync(p, "{}");
    utimesSync(p, new Date(1_000), new Date(1_000));
    const out = sweepSshTerminalState(dataDir, 1_000 + 7 * 24 * 60 * 60 * 1000 + 1, {
      isPaneLive: () => {
        throw new Error("tmux did not answer");
      },
    });
    expect(out.deleted).toBe(0);
    expect(existsSync(p)).toBe(true);
  });
});

describe("facts envelope", () => {
  it("echoes exactly the frozen field set", () => {
    const facts = buildRunFacts(completeState(makeRunId(118)));
    expect(Object.keys(facts).sort()).toEqual(
      [
        "cancelLocalConfirmed",
        "cancelRequested",
        "deadlineHit",
        "lifecycle",
        "localExitCode",
        "localExitSignal",
        "remoteStatus",
        "remoteStatusConfirmed",
        "runId",
      ].sort(),
    );
  });

  it("fresh ensureSshDirs dirs come 0700 (the mode after a fresh create, the documented non-repair of old ones)", () => {
    const wide = join(root, "wide-data");
    ensureSshDirs(wide);
    const d = join(wide, "ssh", "runs");
    expect(lstatSync(d).mode & 0o777).toBe(0o700);
    chmodSync(d, 0o755);
    ensureSshDirs(wide); // second call: existed already, sweep posture does not re-tighten
    expect(listRunIds(wide)).toEqual([]);
  });
});
