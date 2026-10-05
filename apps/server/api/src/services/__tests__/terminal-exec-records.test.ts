import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@internal/backend-errors";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { NewSshTerminalExec } from "@/db/types/ssh-terminal-execs.db-types.js";
import { createSentinelScanner, execSentinelToken, windowIsPartial } from "@/services/nodes/pane-exec.js";
import {
  cancelObservation,
  completeExec,
  hasBlockingUnknown,
  invalidateOutstandingExecs,
  loadExec,
  markExecUnknown,
  observationActive,
  observeExecToResolution,
  paneHeld,
  reconcileStaleIncarnation,
  releasePane,
  toExecView,
  tryHoldPane,
} from "@/services/terminal-exec-records.js";

/**
 * The terminal-exec RECORD lifecycle (task-C brief deliverable 1,
 * SSH-SUPPORT.md §3 "Existing exec_in_terminal"): the durable outstanding
 * row, the bounded late-marker observation, and the honest `unknown`
 * transition. A scripted clock drives the observation loop (no wall time),
 * and a scripted log reader feeds it the way a pane would - the same
 * `cursorLinesFromWindow` + scanner machinery the production loop runs.
 */

const subshells = new SubshellsRepository(db);

beforeAll(ensureMigratedTestDb);

/** A pane row to hang records on (`ssh_terminal_execs.subshell_id` is an FK). */
async function seedPane(): Promise<string> {
  const row = await subshells.create({
    id: crypto.randomUUID(),
    userId: "exec-records-test-user",
    harnessId: "terminal",
    name: "exec-record-pane",
    workingDir: "/tmp",
  });
  return row.id;
}

function newRow(subshellId: string, over: Partial<NewSshTerminalExec> = {}): NewSshTerminalExec {
  return {
    id: crypto.randomUUID(),
    subshellId,
    paneIncarnation: "2026-10-04T00:00:00.000Z",
    initiatedBy: "agent",
    grantId: null,
    apiKeyId: null,
    inputGeneration: 1,
    markerToken: execSentinelToken(),
    state: "outstanding",
    ...over,
  };
}

/** Insert a record through the module the same way the exec path does. */
async function put(row: NewSshTerminalExec): Promise<string> {
  await db
    .insertInto("sshTerminalExecs")
    .values({ ...row, createdAt: new Date().toISOString(), outputTruncated: 0 })
    .execute();
  return row.id;
}

/** Scripted pacing: every loop `sleep` advances a fake clock by `ms`. */
function scriptedClock(ms = 5_000) {
  let now = 1_000;
  return {
    sleep: async () => {
      now += ms;
    },
    now: () => now,
  };
}

describe("the exec record store", () => {
  it("inserts outstanding with the seeded observation cursor and reads back", async () => {
    const pane = await seedPane();
    const row = newRow(pane);
    await db
      .insertInto("sshTerminalExecs")
      .values({ ...row, createdAt: new Date().toISOString(), outputTruncated: 0 })
      .execute();
    await db.updateTable("sshTerminalExecs").set({ nextByte: 40 }).where("id", "=", row.id).execute();
    const loaded = await loadExec(db, row.id);
    expect(loaded?.state).toBe("outstanding");
    expect(loaded?.nextByte).toBe(40);
    expect(loaded?.resolvedAt).toBeNull();
  });

  it("completion and unknown are one-shot: a resolved record never re-transitions", async () => {
    const pane = await seedPane();
    const id = await put(newRow(pane));
    expect(await completeExec(db, id, 0, "hi", false, 11)).toBe(true);
    expect(await completeExec(db, id, 1, "bye", false, 22)).toBe(false);
    expect(await markExecUnknown(db, id, 33)).toBe(false);
    const loaded = await loadExec(db, id);
    expect(loaded?.state).toBe("completed");
    expect(loaded?.exitCode).toBe(0);
    expect(loaded?.nextByte).toBe(11);
  });

  it("reconcile moves only the OLD incarnation's outstanding rows to unknown", async () => {
    const pane = await seedPane();
    const current = newRow(pane);
    const stale = newRow(pane, { paneIncarnation: "2026-10-05T00:00:00.000Z" });
    await put(current);
    await put(stale);
    expect(await reconcileStaleIncarnation(db, pane, current.paneIncarnation)).toBe(1);
    expect((await loadExec(db, current.id))?.state).toBe("outstanding");
    expect((await loadExec(db, stale.id))?.state).toBe("unknown");
  });

  it("takeover invalidation moves every outstanding row on the pane and leaves resolved rows alone", async () => {
    const pane = await seedPane();
    const outstanding = await put(newRow(pane));
    const completed = await put(newRow(pane, { state: "completed", exitCode: 0 }));
    expect(await invalidateOutstandingExecs(db, pane)).toBe(1);
    expect((await loadExec(db, outstanding))?.state).toBe("unknown");
    expect((await loadExec(db, completed))?.state).toBe("completed");
  });

  it("blocking-unknown reads the NEWEST row in the current incarnation (recovery and restart clear it)", async () => {
    const pane = await seedPane();
    const inc = "2026-10-04T00:00:00.000Z";
    await db
      .insertInto("sshTerminalExecs")
      .values({
        ...newRow(pane, { paneIncarnation: inc, state: "unknown" }),
        createdAt: "2026-10-04T01:00:00.000Z",
        outputTruncated: 0,
        resolvedAt: "x",
      })
      .execute();
    expect(await hasBlockingUnknown(db, pane, inc)).toBe(true);
    // A completed record NEWER than the unknown one is the human-recovery fact.
    await db
      .insertInto("sshTerminalExecs")
      .values({
        ...newRow(pane, { paneIncarnation: inc, state: "completed", exitCode: 0 }),
        createdAt: "2026-10-04T02:00:00.000Z",
        outputTruncated: 0,
        resolvedAt: "y",
      })
      .execute();
    expect(await hasBlockingUnknown(db, pane, inc)).toBe(false);
    // A restart is the other clear: against a NEW incarnation, old rows are
    // not this pane's truth at all.
    expect(await hasBlockingUnknown(db, pane, "2026-10-06T00:00:00.000Z")).toBe(false);
    // A still-outstanding newest row does NOT block via this predicate (the
    // lease refuses the second exec as EXEC_IN_FLIGHT first; a completed
    // recovery stays the newest).
    await db
      .insertInto("sshTerminalExecs")
      .values({ ...newRow(pane, { paneIncarnation: inc }), createdAt: "2026-10-04T03:00:00.000Z", outputTruncated: 0 })
      .execute();
    expect(await hasBlockingUnknown(db, pane, inc)).toBe(false);
  });

  it("toExecView mirrors the frozen SshTerminalExecView fields", async () => {
    const row = newRow(await seedPane(), { state: "completed", exitCode: 3, output: "tail", outputTruncated: 1 });
    const view = toExecView({ ...row, createdAt: "c", resolvedAt: "r", nextByte: 7 });
    expect(view).toEqual({
      id: row.id,
      subshellId: row.subshellId,
      state: "completed",
      exitCode: 3,
      output: "tail",
      outputTruncated: true,
      nextByte: 7,
      inputGeneration: 1,
      createdAt: "c",
      resolvedAt: "r",
    });
  });
});

describe("the bounded late-marker observation", () => {
  it("completes the record when the sentinel arrives AFTER the caller's wait", async () => {
    const pane = await seedPane();
    const row = newRow(pane);
    const id = await put(row);
    const enc = new TextEncoder();
    const token = row.markerToken;
    let poll = 0;
    const clock = scriptedClock();
    await observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: token, startByte: 100, priorLines: ["typed echo"], budgetMs: 100_000 },
      {
        read: async (fromByte: number) => {
          poll++;
          // A quiet pane for two polls; then a partial output line; then the
          // LATE marker. (The scanner's carry makes the split honest.)
          const text = poll < 3 ? "" : poll === 3 ? "building" : `\n__xcomm_${token}_DONE rc=5\n`;
          const bytes = enc.encode(text);
          return { bytes, size: fromByte + bytes.byteLength };
        },
        isPaneCurrent: async () => true,
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    const loaded = await loadExec(db, id);
    expect(loaded?.state).toBe("completed");
    expect(loaded?.exitCode).toBe(5);
    expect(loaded?.output).toContain("building");
    expect(loaded?.output).toContain("typed echo");
    expect(loaded?.resolvedAt).not.toBeNull();
  });

  it("marks unknown when the pane stops being the same live pane (restart/death)", async () => {
    const pane = await seedPane();
    const id = await put(newRow(pane));
    const clock = scriptedClock();
    await observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: "0123456789abcdef", startByte: 0, priorLines: [], budgetMs: 100_000 },
      {
        read: async () => ({ bytes: new Uint8Array(0), size: 0 }),
        isPaneCurrent: async () => false,
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect((await loadExec(db, id))?.state).toBe("unknown");
  });

  it("a THROWING liveness probe counts as lost (fail closed, never an infinite watch)", async () => {
    const pane = await seedPane();
    const id = await put(newRow(pane));
    const clock = scriptedClock();
    await observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: "0123456789abcdef", startByte: 0, priorLines: [], budgetMs: 100_000 },
      {
        read: async () => ({ bytes: new Uint8Array(0), size: 0 }),
        isPaneCurrent: async () => {
          throw new Error("db blip");
        },
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect((await loadExec(db, id))?.state).toBe("unknown");
  });

  it("the budget ends the watch as unknown - bounded memory, no unbounded reservation", async () => {
    const pane = await seedPane();
    const id = await put(newRow(pane));
    const clock = scriptedClock(10_000);
    await observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: "0123456789abcdef", startByte: 0, priorLines: [], budgetMs: 30_000 },
      {
        read: async () => ({ bytes: new Uint8Array(0), size: 0 }),
        isPaneCurrent: async () => true,
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect((await loadExec(db, id))?.state).toBe("unknown");
    expect(observationActive(id)).toBe(false);
  });

  it("re-arming a watched record returns the SAME watch (one loop per record per process)", async () => {
    const pane = await seedPane();
    const id = await put(newRow(pane));
    const clock = scriptedClock();
    let paneCurrent = true;
    let reads = 0;
    const deps = {
      read: async () => {
        reads++;
        return { bytes: new Uint8Array(0), size: 0 };
      },
      isPaneCurrent: async () => paneCurrent,
      sleep: clock.sleep,
      now: clock.now,
    };
    const a = observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: "0123456789abcdef", startByte: 0, priorLines: [], budgetMs: 10_000 },
      deps,
    );
    const b = observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: "0123456789abcdef", startByte: 0, priorLines: [], budgetMs: 10_000 },
      deps,
    );
    expect(a).toBe(b);
    paneCurrent = false; // end it
    await a;
    expect(reads).toBeLessThanOrEqual(2); // one loop, not two
  });

  it("cancelObservation marks unknown now and the running loop cannot later complete the row", async () => {
    const pane = await seedPane();
    const row = newRow(pane);
    const id = await put(row);
    const token = row.markerToken;
    const enc = new TextEncoder();
    let deliverMarker = false;
    let polls = 0;
    // A GATED sleep: the loop suspends in its first wait and stays there
    // until the test releases it, so the cancel lands while it is genuinely
    // running (and the fake clock never reaches the budget).
    let release: () => void = () => {};
    const watch = observeExecToResolution(
      db,
      { id, subshellId: pane, markerToken: token, startByte: 0, priorLines: [], budgetMs: 1_000_000 },
      {
        read: async (fromByte: number) => {
          polls++;
          const text = deliverMarker ? `__xcomm_${token}_DONE rc=0\n` : "";
          const bytes = enc.encode(text);
          return { bytes, size: fromByte + bytes.byteLength };
        },
        isPaneCurrent: async () => true,
        sleep: () => new Promise<void>((r) => (release = r)),
        now: () => 1, // constant: the loop exits by marker hit, not deadline
      },
    );
    // Let the loop complete its first (quiet) poll and suspend in the sleep.
    while (polls < 1) await new Promise((r) => setTimeout(r, 1));
    expect(await cancelObservation(db, pane)).toBe(1);
    // The late marker finally arrives - the one-shot guards make it a no-op
    // against the unknown row.
    deliverMarker = true;
    release();
    await watch;
    expect((await loadExec(db, id))?.state).toBe("unknown");
  });
});

describe("the pane reservation", () => {
  it("holds are per pane, synchronous, and release hands over to an observation", async () => {
    const id = crypto.randomUUID();
    expect(paneHeld(id)).toBe(false);
    expect(tryHoldPane(id)).toBe(true);
    expect(tryHoldPane(id)).toBe(false); // the EXEC_IN_FLIGHT condition
    const obs = new Promise<void>((r) => setTimeout(r, 20));
    releasePane(id, obs);
    expect(paneHeld(id)).toBe(true); // still reserved while the watch runs
    await obs;
    await new Promise((r) => setTimeout(r, 5));
    expect(paneHeld(id)).toBe(false);
    expect(tryHoldPane(id)).toBe(true);
    releasePane(id);
  });
});

/**
 * The scanner wiring the observation reuses - pinned so the loop's S1
 * partial-line rule cannot drift from what the caller's wait already proved.
 */
describe("observation scanner equivalence", () => {
  it("the loop's split-marker recognition matches the caller wait's", () => {
    const token = execSentinelToken();
    const scanner = createSentinelScanner(token);
    const partial = `__xcomm_${token}`;
    expect(scanner.push([partial], windowIsPartial(new TextEncoder().encode(partial)))).toBeNull();
    const hit = scanner.push(["_DONE rc=7"], false);
    expect(hit?.rc).toBe(7);
    void stripAnsi; // (window lines arrive ANSI-stripped via cursorLinesFromWindow)
  });
});
