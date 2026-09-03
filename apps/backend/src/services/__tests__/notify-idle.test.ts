import { describe, expect, it } from "bun:test";
import type { NotifyKind } from "@/services/notify.service.js";
import { createIdleWatcher, IDLE_QUIET_MS, IDLE_TICK_MS } from "@/services/notify-idle.js";

/** The row shape the watcher reads (a subset of `SubshellTable`). */
interface FakeRow {
  id: string;
  alive: number;
  harnessId: string;
  waitingSince: string | null;
}

function fakeRow(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return { id, alive: 1, harnessId: "opencode", waitingSince: null, ...overrides };
}

/** What the fake deps recorded, in call order. */
interface FakeCalls {
  /** `notifySubshell(id, kind)` calls. */
  notified: Array<{ id: string; kind: NotifyKind }>;
  /** `setWaiting(id)` calls. */
  waitingSet: string[];
  /** `clearWaiting(id)` calls. */
  cleared: string[];
}

/**
 * Builds a watcher over pure in-memory fakes: rows and mtimes are mutable
 * closures the test edits between ticks; nothing here touches fs/db/tmux.
 */
function makeWatcher(opts: {
  rows: FakeRow[];
  mtimes: Map<string, number>;
  /** Harness ids whose plugin reports `supportsAttentionHooks === true`. */
  hooked?: Set<string>;
}) {
  const calls: FakeCalls = { notified: [], waitingSet: [], cleared: [] };
  const watcher = createIdleWatcher({
    listRows: async () => opts.rows.map((r) => ({ ...r })),
    statMtimeMs: async (id) => opts.mtimes.get(id) ?? null,
    harnessHasHooks: (harnessId) => opts.hooked?.has(harnessId) === true,
    notifySubshell: async (id, kind) => {
      calls.notified.push({ id, kind });
    },
    setWaiting: async (id) => {
      calls.waitingSet.push(id);
    },
    clearWaiting: async (id) => {
      calls.cleared.push(id);
    },
  });
  return { watcher, calls };
}

/** A base clock far from zero so "quiet" arithmetic can't hide off-by-signs. */
const T0 = 1_700_000_000_000;

describe("idle watcher constants", () => {
  it("exports the 20 s quiet window and 3 s tick", () => {
    expect(IDLE_QUIET_MS).toBe(20_000);
    expect(IDLE_TICK_MS).toBe(3_000);
  });
});

describe("createIdleWatcher.tick", () => {
  it("(a) first tick only seeds state — a long-idle subshell never rings at boot", async () => {
    const rows = [fakeRow("a")];
    const mtimes = new Map([["a", T0]]);
    const { watcher, calls } = makeWatcher({ rows, mtimes });

    // First sight happens long after the quiet window would have elapsed.
    const firstTick = T0 + IDLE_QUIET_MS + 60_000;
    await watcher.tick(firstTick);

    expect(calls.notified).toEqual([]);
    expect(calls.waitingSet).toEqual([]);
    expect(calls.cleared).toEqual([]);

    // The discriminating assertion: a SECOND quiet tick must still not ring.
    // A seed of `{mtime, fired: false}` would fire here (unchanged mtime,
    // quiet ≫ window), which is the boot ring the spec forbids — the seed
    // must mark an already-quiet log as consumed (`fired = quiet-at-seed`).
    await watcher.tick(firstTick + IDLE_TICK_MS);

    expect(calls.notified).toEqual([]);
    expect(calls.waitingSet).toEqual([]);
    expect(calls.cleared).toEqual([]);
  });

  it("(b) a quiet hook-less row fires turn_complete and setWaiting exactly once", async () => {
    const rows = [fakeRow("a")];
    const mtimes = new Map([["a", T0]]);
    const { watcher, calls } = makeWatcher({ rows, mtimes });

    await watcher.tick(T0); // seed
    expect(calls.notified).toEqual([]);

    await watcher.tick(T0 + IDLE_QUIET_MS); // quiet threshold reached (>=)
    expect(calls.notified).toEqual([{ id: "a", kind: "turn_complete" }]);
    expect(calls.waitingSet).toEqual(["a"]);
    expect(calls.cleared).toEqual([]);

    await watcher.tick(T0 + IDLE_QUIET_MS + IDLE_TICK_MS); // still quiet
    await watcher.tick(T0 + IDLE_QUIET_MS + 10 * IDLE_TICK_MS);
    expect(calls.notified).toHaveLength(1); // no re-fire while mtime stands still
    expect(calls.waitingSet).toHaveLength(1);
  });

  it("(c) mtime growth clears waiting and re-arms — the next quiet period fires again", async () => {
    const rows = [fakeRow("a")];
    const mtimes = new Map([["a", T0]]);
    const { watcher, calls } = makeWatcher({ rows, mtimes });

    await watcher.tick(T0);
    await watcher.tick(T0 + IDLE_QUIET_MS); // first fire
    expect(calls.notified).toHaveLength(1);

    // New output lands; the watcher's own setWaiting is visible on the row.
    const newMtime = T0 + IDLE_QUIET_MS + 5_000;
    mtimes.set("a", newMtime);
    rows[0].waitingSince = new Date(T0 + IDLE_QUIET_MS).toISOString();

    await watcher.tick(newMtime + IDLE_TICK_MS);
    expect(calls.cleared).toEqual(["a"]); // growth → universal waiting-clear
    expect(calls.notified).toHaveLength(1); // the fresh mtime is not quiet yet

    await watcher.tick(newMtime + IDLE_QUIET_MS);
    expect(calls.notified).toHaveLength(2); // re-armed: fires again once quiet
    expect(calls.waitingSet).toEqual(["a", "a"]);
  });

  it("(d) a hooked harness never fires or sets waiting, but growth still clears waiting", async () => {
    const rows = [fakeRow("c", { harnessId: "claude-code" })];
    const mtimes = new Map([["c", T0]]);
    const { watcher, calls } = makeWatcher({ rows, mtimes, hooked: new Set(["claude-code"]) });

    await watcher.tick(T0);
    await watcher.tick(T0 + IDLE_QUIET_MS);
    await watcher.tick(T0 + IDLE_QUIET_MS + IDLE_TICK_MS);
    expect(calls.notified).toEqual([]); // the hook owns the chip, not the watcher
    expect(calls.waitingSet).toEqual([]);

    mtimes.set("c", T0 + IDLE_QUIET_MS + 2_000);
    rows[0].waitingSince = new Date(T0).toISOString();
    await watcher.tick(T0 + IDLE_QUIET_MS + 5_000);
    expect(calls.cleared).toEqual(["c"]); // clearing on growth is universal
    expect(calls.notified).toEqual([]);
  });

  it("(d2) growth within the settle window does not clear a fresh chip (trailing hook output)", async () => {
    // Live regression: Claude's Stop hook stamps waiting_since, then the
    // TUI's trailing redraw flushes within a second — growth the watcher
    // must NOT read as "the operator replied". After the settle window,
    // growth clears again as before.
    const rows = [fakeRow("c2", { harnessId: "claude-code" })];
    const mtimes = new Map([["c2", T0]]);
    const { watcher, calls } = makeWatcher({ rows, mtimes, hooked: new Set(["claude-code"]) });

    await watcher.tick(T0);
    const setAt = T0 + 1_000;
    rows[0].waitingSince = new Date(setAt).toISOString(); // hook fires
    mtimes.set("c2", T0 + 2_000); // trailing redraw lands 1s later
    await watcher.tick(setAt + 1_500); // within the grace
    expect(calls.cleared).toEqual([]); // chip survives its own turn's tail

    // A real reply after the grace: growth now clears.
    mtimes.set("c2", T0 + 30_000);
    await watcher.tick(setAt + 30_000);
    expect(calls.cleared).toEqual(["c2"]);
  });

  it("(e) alive=0 rows are ignored entirely", async () => {
    const rows = [fakeRow("d", { alive: 0 })];
    const mtimes = new Map([["d", T0]]);
    const { watcher, calls } = makeWatcher({ rows, mtimes });

    await watcher.tick(T0);
    await watcher.tick(T0 + IDLE_QUIET_MS + 1);

    expect(calls.notified).toEqual([]);
    expect(calls.waitingSet).toEqual([]);
    expect(calls.cleared).toEqual([]);
  });

  it("a missing log (null mtime) neither seeds nor fires; it fires once the log exists", async () => {
    const rows = [fakeRow("e")];
    const mtimes = new Map<string, number>(); // no log file yet
    const { watcher, calls } = makeWatcher({ rows, mtimes });

    await watcher.tick(T0);
    await watcher.tick(T0 + IDLE_QUIET_MS);
    expect(calls.notified).toEqual([]);

    mtimes.set("e", T0 + IDLE_QUIET_MS); // first output appears
    await watcher.tick(T0 + IDLE_QUIET_MS); // seed only
    expect(calls.notified).toEqual([]);

    await watcher.tick(T0 + 2 * IDLE_QUIET_MS);
    expect(calls.notified).toEqual([{ id: "e", kind: "turn_complete" }]);
  });

  it("rows that disappear are dropped from state — a reappearance re-seeds silently", async () => {
    const mtimes = new Map([["f", T0]]);
    const rows = [fakeRow("f")];
    const { watcher, calls } = makeWatcher({ rows, mtimes });

    await watcher.tick(T0);
    await watcher.tick(T0 + IDLE_QUIET_MS);
    expect(calls.notified).toHaveLength(1);

    rows.length = 0; // row no longer listed (terminated)
    await watcher.tick(T0 + IDLE_QUIET_MS + IDLE_TICK_MS); // pruned from state

    // Reappears with a FRESH log that is not quiet yet at this tick, and a
    // stale waiting chip on the row.
    const reappearMtime = T0 + IDLE_QUIET_MS + 2 * IDLE_TICK_MS;
    mtimes.set("f", reappearMtime);
    rows.push(fakeRow("f", { waitingSince: new Date(T0).toISOString() }));
    await watcher.tick(reappearMtime);
    expect(calls.notified).toHaveLength(1); // first sight is seed-only
    // This pins PRUNING: pruned, the row is unseen → the seed path runs and
    // never clears. Had the state survived the gone-tick, the mtime change
    // would look like growth and `clearWaiting("f")` would fire here.
    expect(calls.cleared).toEqual([]);

    // Only now is the re-seeded row quiet for the full window: the fresh seed
    // (fired = quiet-at-seed = false) arms the fire the retained state (already
    // consumed) would never have produced.
    await watcher.tick(reappearMtime + IDLE_QUIET_MS);
    expect(calls.notified).toHaveLength(2); // re-armed by re-seed: fires again
  });

  it("one row's failing notifySubshell does not stall the rest of the loop", async () => {
    const rows = [fakeRow("bad"), fakeRow("good")];
    const mtimes = new Map([
      ["bad", T0],
      ["good", T0],
    ]);
    const waitingSet: string[] = [];
    const watcher = createIdleWatcher({
      listRows: async () => rows.map((r) => ({ ...r })),
      statMtimeMs: async (id) => mtimes.get(id) ?? null,
      harnessHasHooks: () => false,
      notifySubshell: async (id) => {
        if (id === "bad") throw new Error("boom");
      },
      setWaiting: async (id) => {
        waitingSet.push(id);
      },
      clearWaiting: async () => {},
    });

    await watcher.tick(T0);
    await watcher.tick(T0 + IDLE_QUIET_MS); // "bad" throws; the loop must continue
    expect(waitingSet).toContain("good"); // "good" was still processed
    expect(waitingSet).not.toContain("bad"); // its setWaiting was skipped by the throw
  });

  it("a failing listRows never rejects tick (a throwing interval must not kill the process)", async () => {
    const watcher = createIdleWatcher({
      listRows: async () => {
        throw new Error("db gone");
      },
      statMtimeMs: async () => null,
      harnessHasHooks: () => false,
      notifySubshell: async () => {},
      setWaiting: async () => {},
      clearWaiting: async () => {},
    });
    await watcher.tick(T0); // must resolve, not reject
  });
});
