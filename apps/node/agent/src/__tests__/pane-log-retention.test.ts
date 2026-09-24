import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxRunner } from "@internal/pane-runtime";
import {
  createRetentionPass,
  DEFAULT_LOG_RETENTION,
  type LogRetention,
  resolveLogRetention,
  resolveLogRetentionState,
  sweepExpiredPaneLogs,
} from "../pane-log-retention.js";
import type { SubshellMeta, SubshellMetaStore } from "../subshell-meta.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Pane ids are uuid-shaped: `isSubshellId` gates the name shape, so the tests
// use ids that pass it and stray names that cannot.
const ID_DEAD = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_ORPHAN = "bbbbbbbb-0000-4000-8000-000000000002";
const ID_FRESH = "cccccccc-0000-4000-8000-000000000003";
const ID_ALIVE = "dddddddd-0000-4000-8000-000000000004";

function meta(id: string, socket = "sock1"): SubshellMeta {
  return {
    subshellId: id,
    cwd: "/tmp/whatever",
    socket,
    harnessId: "claude-code",
    name: id,
    startedAt: new Date(0).toISOString(),
  };
}

let dataDir: string;
let subshellsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "subshell-retention-"));
  subshellsDir = join(dataDir, "subshells");
  mkdirSync(subshellsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Write `<id>.log` with an mtime `ageMs` old; returns its path. */
function writeLog(id: string, ageMs: number, content = "typed secret\n"): string {
  const file = join(subshellsDir, `${id}.log`);
  writeFileSync(file, content);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
  return file;
}

/** A sweep over the temp dir with a fake census: `alive` ids answer true. */
async function sweep(
  retention: LogRetention,
  metas: SubshellMeta[],
  opts: { alive?: Set<string>; throws?: Set<string> } = {},
) {
  const alive = opts.alive ?? new Set<string>();
  const throws = opts.throws ?? new Set<string>();
  return await sweepExpiredPaneLogs({
    dataDir,
    retention,
    meta: { list: async () => metas } as unknown as Pick<SubshellMetaStore, "list">,
    tmux: {
      hasSubshell: async (_socket: string, id: string) => {
        if (throws.has(id)) throw new Error("tmux did not answer");
        return alive.has(id);
      },
    } as unknown as Pick<TmuxRunner, "hasSubshell">,
  });
}

describe("sweepExpiredPaneLogs", () => {
  it("deletes an expired non-running log and an orphan; keeps the young one", async () => {
    const dead = writeLog(ID_DEAD, DAY_MS * 2);
    const orphan = writeLog(ID_ORPHAN, DAY_MS * 3);
    const fresh = writeLog(ID_FRESH, HOUR_MS);
    const result = await sweep({ days: 1, hours: 0 }, [meta(ID_DEAD)]);
    expect(result.removed.sort()).toEqual([ID_DEAD, ID_ORPHAN].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never sweeps a running pane's log, however old", async () => {
    const running = writeLog(ID_ALIVE, DAY_MS * 30);
    const result = await sweep({ days: 1, hours: 0 }, [meta(ID_ALIVE)], { alive: new Set([ID_ALIVE]) });
    expect(result.removed).toEqual([]);
    expect(existsSync(running)).toBe(true);
  });

  it("counts a liveness probe that cannot answer as RUNNING, not dead", async () => {
    // A delete is destructive; "tmux did not answer" is not "tmux said no".
    const wedged = writeLog(ID_ALIVE, DAY_MS * 30);
    const result = await sweep({ days: 1, hours: 0 }, [meta(ID_ALIVE)], { throws: new Set([ID_ALIVE]) });
    expect(result.removed).toEqual([]);
    expect(existsSync(wedged)).toBe(true);
  });

  it("0 days + 0 hours keeps everything, whatever the age", async () => {
    const ancient = writeLog(ID_ORPHAN, DAY_MS * 400);
    const result = await sweep({ days: 0, hours: 0 }, []);
    expect(result.removed).toEqual([]);
    expect(existsSync(ancient)).toBe(true);
  });

  it("hours-only: 0 days + 6 hours ages out a 7-hour-old log and keeps a 5-hour one", async () => {
    const aged = writeLog(ID_DEAD, 7 * HOUR_MS);
    const kept = writeLog(ID_FRESH, 5 * HOUR_MS);
    const result = await sweep({ days: 0, hours: 6 }, []);
    expect(result.removed).toEqual([ID_DEAD]);
    expect(existsSync(aged)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("with no configuration at all the default ages out yesterday's transcript", async () => {
    // The tightening this feature ships: an unconfigured node used to keep
    // every log until the plane commanded `remove_paths`.
    const resolved = resolveLogRetention({}, {});
    expect(resolved).toMatchObject({ days: 1, hours: 0, forever: false, problems: [] });
    const yesterday = writeLog(ID_ORPHAN, 25 * HOUR_MS);
    const stillToday = writeLog(ID_FRESH, 23 * HOUR_MS);
    const result = await sweep(resolved, []);
    expect(result.removed).toEqual([ID_ORPHAN]);
    expect(existsSync(yesterday)).toBe(false);
    expect(existsSync(stillToday)).toBe(true);
  });

  it("touches only pane-log name shapes — strays, dotfiles and directories stay", async () => {
    const notes = join(subshellsDir, "notes.txt");
    writeFileSync(notes, "x");
    const dot = join(subshellsDir, ".log"); // empty id — not a subshell id
    writeFileSync(dot, "x");
    const weird = join(subshellsDir, "zz!!.log"); // non-id characters in the name
    writeFileSync(weird, "x");
    mkdirSync(join(subshellsDir, `${ID_DEAD}.log`)); // a DIRECTORY wearing the log suffix
    const all = DAY_MS * 10;
    utimesSync(notes, (Date.now() - all) / 1000, (Date.now() - all) / 1000);
    utimesSync(dot, (Date.now() - all) / 1000, (Date.now() - all) / 1000);
    utimesSync(weird, (Date.now() - all) / 1000, (Date.now() - all) / 1000);
    const result = await sweep({ days: 1, hours: 0 }, []);
    expect(result.removed).toEqual([]);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(dot)).toBe(true);
    expect(existsSync(weird)).toBe(true);
    expect(existsSync(join(subshellsDir, `${ID_DEAD}.log`))).toBe(true);
  });

  it("never follows a symlink out of the dir — neither the link nor its target is touched", async () => {
    // The `remove_paths` rule, reused: `pathAllowed` refuses a symlink leaf,
    // and even if it did not, `unlink` removes links, not targets.
    const outside = join(dataDir, "outside-evidence.log");
    writeFileSync(outside, "do not delete me");
    const t = (Date.now() - DAY_MS * 10) / 1000;
    utimesSync(outside, t, t);
    const link = join(subshellsDir, `${ID_DEAD}.log`);
    symlinkSync(outside, link);
    const result = await sweep({ days: 1, hours: 0 }, []);
    expect(result.removed).toEqual([]);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  /**
   * C6, and the node is where this race bites hardest: the default window is
   * ONE day, so a transcript is always exactly one day of silence away from
   * being a unlink candidate, and the census runs once at the top of each
   * pass. A RESTART reuses the same log path append-only with the old mtime
   * (pane-runtime `pane-log.ts`), so a pane that came back inside the
   * census→unlink window must be caught by a fresh per-file probe, not by the
   * snapshot.
   */
  it("the one-day default ages out yesterday's transcripts, but a restart landing after the census survives", async () => {
    const restarted = writeLog(ID_DEAD, DAY_MS * 2);
    const gone = writeLog(ID_ALIVE, DAY_MS * 2);
    const calls = new Map<string, number>();
    const result = await sweepExpiredPaneLogs({
      dataDir,
      retention: { days: 1, hours: 0 },
      meta: {
        list: async () => [meta(ID_DEAD), meta(ID_ALIVE)],
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["meta"],
      tmux: {
        hasSubshell: async (_socket: string, id: string) => {
          const n = (calls.get(id) ?? 0) + 1;
          calls.set(id, n);
          // Census (call 1): both dead. Re-probe (call 2): ID_DEAD restarted.
          return id === ID_DEAD && n >= 2;
        },
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["tmux"],
    });
    expect(result.removed).toEqual([ID_ALIVE]);
    expect(existsSync(restarted)).toBe(true);
    expect(existsSync(gone)).toBe(false);
    // The re-probe is only spent on files the pass was about to unlink: both
    // censused, only the expired-and-not-alive ones re-probed.
    expect(calls.get(ID_DEAD)).toBe(2);
    expect(calls.get(ID_ALIVE)).toBe(2);
  });

  it("a per-file re-probe that cannot answer counts as RUNNING too — unknown is not dead at the unlink moment either", async () => {
    const wedged = writeLog(ID_DEAD, DAY_MS * 2);
    const calls = new Map<string, number>();
    const result = await sweepExpiredPaneLogs({
      dataDir,
      retention: { days: 1, hours: 0 },
      meta: {
        list: async () => [meta(ID_DEAD)],
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["meta"],
      tmux: {
        hasSubshell: async (_socket: string, id: string) => {
          const n = (calls.get(id) ?? 0) + 1;
          calls.set(id, n);
          if (n === 1) return false; // census: gone
          throw new Error("tmux did not answer"); // re-probe: unanswerable
        },
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["tmux"],
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(wedged)).toBe(true);
    expect(calls.get(ID_DEAD)).toBe(2);
  });

  /**
   * Finding 2: production mints one tmux socket per subshell, so the census
   * is one probe per record however it is shaped — what a wedged host used to
   * turn into N × the tmux timeout is the SERIALITY, and this pins it away.
   * The probe's shape is read directly: peak in-flight and wall-time. 10
   * records against the cap of 8 → the first wave of 8 starts together
   * (bodies run to their first `await` synchronously), and serial 10 × 30 ms
   * would overshoot the wall budget by ~5×.
   */
  it("probes the census concurrently, capped — wall-time is a timeout's order, not the pane count's", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `aaaaaaaa-0000-4000-8000-00000000000${i}`);
    for (const id of ids) writeLog(id, 2 * DAY_MS); // all old enough to be candidates if the census said dead
    let inFlight = 0;
    let peak = 0;
    const started = Date.now();
    const result = await sweepExpiredPaneLogs({
      dataDir,
      retention: { days: 1, hours: 0 },
      meta: {
        list: async () => ids.map((id) => meta(id)),
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["meta"],
      tmux: {
        hasSubshell: async (_socket: string, _id: string) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight -= 1;
          throw new Error("wedged host: tmux never answers");
        },
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["tmux"],
    });
    expect(peak).toBeGreaterThan(1); // concurrent
    expect(peak).toBeLessThanOrEqual(8); // capped — no fork storm on hundreds of stale records
    expect(Date.now() - started).toBeLessThan(200); // serial would be ≥ 300
    // And the safety rule survives the reshaping: every probe that could not
    // answer counted its pane running, so nothing here was even a candidate.
    expect(result.removed).toEqual([]);
    for (const id of ids) expect(existsSync(join(subshellsDir, `${id}.log`))).toBe(true);
  });

  it("an orphan (no meta record) has nothing to re-probe — the missed delete still ages out", async () => {
    const orphan = writeLog(ID_ORPHAN, DAY_MS * 2);
    const result = await sweepExpiredPaneLogs({
      dataDir,
      retention: { days: 1, hours: 0 },
      meta: { list: async () => [] } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["meta"],
      tmux: {
        hasSubshell: async () => {
          throw new Error("must not be probed — there is no record for it");
        },
      } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["tmux"],
    });
    expect(result.removed).toEqual([ID_ORPHAN]);
    expect(existsSync(orphan)).toBe(false);
  });

  it("a missing subshells dir is silence, not a failure", async () => {
    rmSync(subshellsDir, { recursive: true, force: true });
    const result = await sweep({ days: 1, hours: 0 }, []);
    expect(result.removed).toEqual([]);
  });
});

describe("resolveLogRetention", () => {
  it("defaults to one day, per the operator's ruling", () => {
    expect(DEFAULT_LOG_RETENTION).toEqual({ days: 1, hours: 0 });
    expect(resolveLogRetention({}, {})).toEqual({ days: 1, hours: 0, forever: false, problems: [] });
  });

  it("lets the environment win over config.json, per field", () => {
    const cfg = { logRetentionDays: 30, logRetentionHours: 5 };
    expect(resolveLogRetention({ SUBSHELL_LOG_RETENTION_DAYS: "0", SUBSHELL_LOG_RETENTION_HOURS: "0" }, cfg)).toEqual({
      days: 0,
      hours: 0,
      forever: true,
      problems: [],
    });
    // Half-overridden: env days + stored hours compose, they do not veto each other.
    expect(resolveLogRetention({ SUBSHELL_LOG_RETENTION_DAYS: "3" }, cfg)).toEqual({
      days: 3,
      hours: 5,
      forever: false,
      problems: [],
    });
    expect(resolveLogRetention({}, cfg)).toEqual({ days: 30, hours: 5, forever: false, problems: [] });
  });

  it("names an unusable env spelling and falls to the next layer", () => {
    const cfg = { logRetentionDays: 7 };
    const r = resolveLogRetention({ SUBSHELL_LOG_RETENTION_DAYS: "many", SUBSHELL_LOG_RETENTION_HOURS: "-2" }, cfg);
    expect(r.days).toBe(7); // fell to the stored value
    expect(r.hours).toBe(0); // fell to the default
    expect(r.problems.length).toBe(2);
    expect(r.problems.join("\n")).toContain("SUBSHELL_LOG_RETENTION_DAYS");
    expect(r.problems.join("\n")).toContain("SUBSHELL_LOG_RETENTION_HOURS");
  });

  it("treats a blank env value as the variable having no answer, not a bad one", () => {
    // The SUBSHELL_DASHBOARD_PORT precedent: "" is unset, a leftover with
    // nothing behind it. A problem line for it would be noise.
    const r = resolveLogRetention({ SUBSHELL_LOG_RETENTION_DAYS: "  " }, { logRetentionDays: 2 });
    expect(r.days).toBe(2);
    expect(r.problems).toEqual([]);
  });
});

describe("resolveLogRetentionState", () => {
  it("names the layer each field came from", () => {
    const s = resolveLogRetentionState({}, {});
    expect(s.days).toEqual({ value: 1, source: "default", forced: false });
    expect(s.hours).toEqual({ value: 0, source: "default", forced: false });
    expect(s.forever).toBe(false);

    const stored = resolveLogRetentionState({}, { logRetentionDays: 30, logRetentionHours: 6 });
    expect(stored.days).toEqual({ value: 30, source: "stored", forced: false });
    expect(stored.hours).toEqual({ value: 6, source: "stored", forced: false });
  });

  it("marks ONLY the env-answered field as forced", () => {
    // The per-field rule the setter refuses by: env-days forces days-writes
    // and says nothing about hours.
    const s = resolveLogRetentionState({ SUBSHELL_LOG_RETENTION_DAYS: "3" }, { logRetentionHours: 5 });
    expect(s.days).toEqual({ value: 3, source: "env", forced: true });
    expect(s.hours).toEqual({ value: 5, source: "stored", forced: false });
  });

  it("an unusable env spelling answers NOTHING, so it forces nothing", () => {
    // A junk env value falls to the next layer with a warn line (the
    // resolution rule above); a write to the layer that IS answering is not
    // masked, so it must stay allowed.
    const s = resolveLogRetentionState({ SUBSHELL_LOG_RETENTION_DAYS: "many", SUBSHELL_LOG_RETENTION_HOURS: " " }, {});
    expect(s.days.source).toBe("default");
    expect(s.days.forced).toBe(false);
    expect(s.hours.forced).toBe(false);
  });

  it("0 + 0 through any layers is the forever pair", () => {
    expect(resolveLogRetentionState({ SUBSHELL_LOG_RETENTION_DAYS: "0" }, { logRetentionHours: 0 }).forever).toBe(true);
  });
});

describe("createRetentionPass", () => {
  /** A pass over the temp dir resolving against `current` each invocation. */
  function pass(current: () => Promise<{ dataDir: string; logRetentionDays?: number; logRetentionHours?: number }>) {
    return createRetentionPass({
      boot: { dataDir, logRetentionDays: 30 },
      meta: { list: async () => [] } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["meta"],
      tmux: { hasSubshell: async () => false } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["tmux"],
      readCurrent: current,
      env: {},
    });
  }

  it("re-resolves the window per pass — a config change lands without a restart", async () => {
    // The live-effect rule behind the dashboard setter: boot says 30 days,
    // so a two-day-old transcript survives the first pass; the config is
    // then rewritten to `0 + 1` and the very next pass deletes it.
    const aged = writeLog(ID_DEAD, 2 * DAY_MS);
    let current: { dataDir: string; logRetentionDays?: number; logRetentionHours?: number } = {
      dataDir,
      logRetentionDays: 30,
    };
    const run = pass(async () => current);
    expect((await run()).removed).toEqual([]);
    current = { dataDir, logRetentionDays: 0, logRetentionHours: 1 };
    expect((await run()).removed).toEqual([ID_DEAD]);
    expect(existsSync(aged)).toBe(false);
  });

  it("keep-forever in the current config makes a scheduled pass a no-op", async () => {
    const old = writeLog(ID_ORPHAN, DAY_MS * 400);
    await pass(async () => ({ dataDir, logRetentionDays: 0, logRetentionHours: 0 }))();
    expect(existsSync(old)).toBe(true);
  });

  it("a config read that throws keeps running on the boot window, and says so once", async () => {
    // The pass must not stop sweeping because one read failed — housekeeping
    // that vanishes on a disk hiccup is worse than housekeeping on the last
    // known window. The failure gets a line (the caller logs it; the sweep
    // must not silently read a stale file forever).
    const aged = writeLog(ID_DEAD, 2 * DAY_MS);
    const errs: string[] = [];
    const run = createRetentionPass({
      boot: { dataDir, logRetentionDays: 0, logRetentionHours: 1 },
      meta: { list: async () => [] } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["meta"],
      tmux: { hasSubshell: async () => false } as unknown as Parameters<typeof sweepExpiredPaneLogs>[0]["tmux"],
      readCurrent: async () => {
        throw new Error("cannot read config");
      },
      onReadError: (m) => errs.push(m),
      env: {},
    });
    expect((await run()).removed).toEqual([ID_DEAD]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("cannot read config");
    expect(existsSync(aged)).toBe(false);
  });
});
