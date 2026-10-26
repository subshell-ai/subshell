import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOG_RETENTION_DAYS } from "@/constants.js";
import { sweepExpiredPaneLogs, tightenPaneLogModes } from "../pane-log-hygiene.js";

/** A throwaway log dir, deliberately created world-readable so tightening is observable. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-hygiene-"));
  chmodSync(dir, 0o755);
  return dir;
}

/** Writes a log file with an explicit mode and age in days. */
function writeLog(dir: string, id: string, opts: { mode?: number; ageDays?: number } = {}): string {
  const file = join(dir, `${id}.log`);
  writeFileSync(file, "some pane output\n");
  chmodSync(file, opts.mode ?? 0o644);
  if (opts.ageDays !== undefined) {
    const when = new Date(Date.now() - opts.ageDays * 86_400_000);
    utimesSync(file, when, when);
  }
  return file;
}

const DAY_MS = 86_400_000;

describe("tightenPaneLogModes", () => {
  it("tightens the directory to 0700 and every log to 0600", () => {
    const dir = freshDir();
    const a = writeLog(dir, "a", { mode: 0o644 });
    const b = writeLog(dir, "b", { mode: 0o666 });

    const result = tightenPaneLogModes(dir);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(statSync(b).mode & 0o777).toBe(0o600);
    expect(result.files).toBe(2);
  });

  it("is idempotent and leaves non-log files alone", () => {
    const dir = freshDir();
    const log = writeLog(dir, "a");
    const other = join(dir, "notes.txt");
    writeFileSync(other, "x");
    chmodSync(other, 0o644);

    tightenPaneLogModes(dir);
    const second = tightenPaneLogModes(dir);

    expect(statSync(log).mode & 0o777).toBe(0o600);
    // Only `<id>.log` files are ours to re-mode; anything else in the data dir
    // belongs to whoever put it there.
    expect(statSync(other).mode & 0o777).toBe(0o644);
    expect(second.files).toBe(1);
  });

  it("reports rather than throws when the directory does not exist", () => {
    const result = tightenPaneLogModes(join(tmpdir(), `subshell-absent-${Date.now()}`));
    expect(result.dir).toBe(false);
    expect(result.files).toBe(0);
  });
});

describe("sweepExpiredPaneLogs", () => {
  it("removes logs older than the window whose subshell is not running", async () => {
    const dir = freshDir();
    const stale = writeLog(dir, "stale", { ageDays: 40 });
    const fresh = writeLog(dir, "fresh", { ageDays: 2 });

    const { removed } = await sweepExpiredPaneLogs({ dir, retentionDays: 30, runningIds: new Set() });

    expect(removed).toEqual(["stale"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never removes a running subshell's log, however old the file looks", async () => {
    // A long-lived agent that has printed nothing for months is still LIVE:
    // its log is the replay buffer an attach reads, and deleting it mid-session
    // would blank the terminal for every viewer.
    const dir = freshDir();
    const running = writeLog(dir, "live-one", { ageDays: 400 });

    const { removed } = await sweepExpiredPaneLogs({
      dir,
      retentionDays: 30,
      runningIds: new Set(["live-one"]),
    });

    expect(removed).toEqual([]);
    expect(existsSync(running)).toBe(true);
  });

  it("treats retentionDays 0 as keep-forever", async () => {
    const dir = freshDir();
    const ancient = writeLog(dir, "ancient", { ageDays: 9999 });

    const { removed } = await sweepExpiredPaneLogs({ dir, retentionDays: 0, runningIds: new Set() });

    expect(removed).toEqual([]);
    expect(existsSync(ancient)).toBe(true);
  });

  it("sweeps orphaned logs — a row deleted whose unlink failed", async () => {
    const dir = freshDir();
    const orphan = writeLog(dir, "orphan", { ageDays: 31 });

    const { removed } = await sweepExpiredPaneLogs({ dir, retentionDays: 30, runningIds: new Set() });

    expect(removed).toEqual(["orphan"]);
    expect(existsSync(orphan)).toBe(false);
  });

  it("measures age against the injected clock, exactly at the boundary", async () => {
    const dir = freshDir();
    const edge = writeLog(dir, "edge", { ageDays: 0 });
    // The file's OWN mtime, not a second `Date.now()`. `writeLog` stamps the
    // file from one reading and this line used to take another; when the two
    // differed by a millisecond — which they do, often — the "exactly at the
    // window" case was actually one past it, and the strict comparison this
    // test exists to pin swept the file and failed. It only showed up in a
    // full run, where the machine is busy enough for the gap to open.
    const nowMs = statSync(edge).mtimeMs;

    // Exactly at the window: not yet expired (the comparison is strict).
    expect(
      (await sweepExpiredPaneLogs({ dir, retentionDays: 1, runningIds: new Set(), nowMs: nowMs + DAY_MS })).removed,
    ).toEqual([]);
    // One millisecond past it: gone.
    expect(
      (await sweepExpiredPaneLogs({ dir, retentionDays: 1, runningIds: new Set(), nowMs: nowMs + DAY_MS + 1 })).removed,
    ).toEqual(["edge"]);
  });

  it("ignores a missing directory and non-log files", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "subshell.db"), "x");
    mkdirSync(join(dir, "mcp"));

    expect((await sweepExpiredPaneLogs({ dir, retentionDays: 1, runningIds: new Set() })).removed).toEqual([]);
    expect(
      (
        await sweepExpiredPaneLogs({
          dir: join(tmpdir(), `subshell-absent-${Date.now()}`),
          retentionDays: 1,
          runningIds: new Set(),
        })
      ).removed,
    ).toEqual([]);
    expect(existsSync(join(dir, "subshell.db"))).toBe(true);
  });

  it("defaults to a 30-day window", () => {
    expect(DEFAULT_LOG_RETENTION_DAYS).toBe(30);
  });

  /**
   * C6: the snapshot goes stale while the loop runs, and a RESTART reuses the
   * log path append-only (pane-runtime `pane-log.ts` opens `a` — no truncate)
   * with the file's old mtime intact until the new pane prints. An id that
   * became running after `runningIds` was built must still survive.
   */
  it("re-checks liveness per file immediately before unlinking — a restart after the snapshot keeps its log", async () => {
    const dir = freshDir();
    const restarted = writeLog(dir, "restarted", { ageDays: 40 });
    const dead = writeLog(dir, "dead", { ageDays: 41 });
    const _young = writeLog(dir, "young", { ageDays: 2 });

    const probed: string[] = [];
    const { removed } = await sweepExpiredPaneLogs({
      dir,
      retentionDays: 30,
      runningIds: new Set(), // the stale snapshot: nothing was running when it was taken
      isStillRunning: (id) => {
        probed.push(id);
        return id === "restarted"; // it came back up between the snapshot and its turn
      },
    });

    expect(removed).toEqual(["dead"]);
    expect(existsSync(restarted)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    // Probed once per ELIGIBLE file — the young one was never a candidate,
    // so no predicate call is spent on it.
    expect(new Set(probed)).toEqual(new Set(["restarted", "dead"]));
  });

  it("a re-check that cannot answer keeps the file — unknown is not dead", async () => {
    const dir = freshDir();
    const file = writeLog(dir, "stale", { ageDays: 40 });

    const { removed } = await sweepExpiredPaneLogs({
      dir,
      retentionDays: 30,
      runningIds: new Set(),
      isStillRunning: () => {
        throw new Error("database went away mid-sweep");
      },
    });

    expect(removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("still sweeps orphans under a re-check — a deleted row is not running", async () => {
    const dir = freshDir();
    const orphan = writeLog(dir, "orphan", { ageDays: 31 });

    const { removed } = await sweepExpiredPaneLogs({
      dir,
      retentionDays: 30,
      runningIds: new Set(),
      isStillRunning: async () => false,
    });

    expect(removed).toEqual(["orphan"]);
    expect(existsSync(orphan)).toBe(false);
  });
});
