import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  beginSelfUpdate,
  beginUpdate,
  hasNonTerminal,
  readView,
  recordNodeDisconnect,
  recordNodeReady,
  resetForTests,
  resolveSelfUpdate,
  STALL_MS,
  TERMINAL_EXPIRE_MS,
  updateOutcomeUnknown,
  updateRefused,
  updateSwapped,
  updateTrackerSeams,
} from "@/services/nodes/update-tracker.js";

/**
 * The in-memory update tracker (design 2026-09-25): every transition the plane
 * witnesses gets one call, and everything a page renders is derived at read
 * time from the entry plus the clock. Terminal phases are never stored — which
 * is why `stalled` can still resolve to `done`, and why the expiry below is a
 * read-time filter rather than a sweeper.
 *
 * The clock is injected through `updateTrackerSeams.now` (the repo's seams
 * idiom) because every interesting boundary here — the stall at exactly
 * STALL_MS, the expiry at exactly `endedAt + TERMINAL_EXPIRE_MS`, a re-press
 * landing in the same millisecond as the press it replaces — is one the real
 * `Date.now()` would test flakily, never falsely.
 */

let nowMs = 1_000_000;
const realNow = updateTrackerSeams.now;

beforeEach(() => {
  resetForTests();
  nowMs = 1_000_000;
  updateTrackerSeams.now = () => nowMs;
});

afterEach(() => {
  // A faked clock leaking past this file would freeze the stall math of every
  // other suite that reads the tracker (the route tests among them).
  updateTrackerSeams.now = realNow;
  resetForTests();
});

describe("beginUpdate / updateSwapped", () => {
  it("opens a working entry carrying from/to/startedAt", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    expect(readView().nodes.n1).toEqual({
      from: "0.8.0",
      to: "0.9.0",
      startedAt: nowMs,
      phase: "working",
      message: null,
      endedAt: null,
    });
  });

  it("a swap confirmation moves working → restarting and stamps nothing else", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    const startedAt = readView().nodes.n1?.startedAt;
    nowMs += 5_000;
    updateSwapped("n1");
    const v = readView().nodes.n1;
    expect(v?.phase).toBe("restarting");
    expect(v?.startedAt).toBe(startedAt);
    expect(v?.endedAt).toBeNull();
  });

  it("a re-press replaces the prior entry wholesale — the clock restarts", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateRefused("n1", "the node refused");
    nowMs += 60_000;
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    expect(readView().nodes.n1).toEqual({
      from: "0.8.0",
      to: "0.9.0",
      startedAt: nowMs,
      phase: "working",
      message: null,
      endedAt: null,
    });
  });

  it("keeps one entry per node", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    beginUpdate("n2", { from: "0.8.1", to: "0.9.0" });
    updateSwapped("n1");
    expect(readView().nodes.n1?.phase).toBe("restarting");
    expect(readView().nodes.n2?.phase).toBe("working");
  });

  it("the post-send seams are no-ops without a begin — a route can never corrupt another's entry", () => {
    updateSwapped("ghost");
    updateRefused("ghost", "nothing began here");
    updateOutcomeUnknown("ghost");
    expect(readView().nodes.ghost).toBeUndefined();
  });
});

describe("updateRefused", () => {
  it("lands failed with the sentence the route answered, and ends the clock", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    nowMs += 30_000;
    updateRefused("n1", "That node is not connected, so nothing can be sent to it");
    const v = readView().nodes.n1;
    expect(v?.phase).toBe("failed");
    expect(v?.message).toBe("That node is not connected, so nothing can be sent to it");
    expect(v?.endedAt).toBe(nowMs);
  });

  it("a terminal entry does not revive for a late ready", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateRefused("n1", "refused");
    recordNodeReady("n1", "0.9.0");
    expect(readView().nodes.n1?.phase).toBe("failed");
  });
});

describe("updateOutcomeUnknown — the timeout posture", () => {
  /**
   * A `timeout` from `sendCommand` is the one failure that may not be one:
   * the node may be mid-download, and will restart into the new binary while
   * the entry still reads `working`. The seam therefore stores nothing —
   * the stall clock keeps running, and the `ready` that eventually lands is
   * still believed. This test is the pin that the posture is DELIBERATE: any
   * future change here is a design change.
   */
  it("leaves the entry working, and a later ready still resolves it done", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateOutcomeUnknown("n1");
    expect(readView().nodes.n1?.phase).toBe("working");
    nowMs += 10_000;
    expect(readView().nodes.n1?.phase).toBe("working");
    recordNodeReady("n1", "0.9.0");
    expect(readView().nodes.n1?.phase).toBe("done");
  });
});

describe("recordNodeReady", () => {
  it("resolves done when the node reports the ordered version", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    nowMs += 4_000;
    recordNodeReady("n1", "0.9.0");
    const v = readView().nodes.n1;
    expect(v?.phase).toBe("done");
    expect(v?.endedAt).toBe(nowMs);
    expect(v?.message).toBeNull();
  });

  it("resolves done when the node reports something NEWER than ordered", () => {
    // A node hand-updated past the offer between the order and the boot; the
    // machine is ahead, which is the outcome the operator wanted either way.
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    recordNodeReady("n1", "0.10.0");
    expect(readView().nodes.n1?.phase).toBe("done");
  });

  it("resolves failed with the rolled-back note when the node comes back OLDER", () => {
    // The boot-revert case (docs/updating.md): the new binary swapped in, then
    // the boot that could not migrate put `from` back.
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    recordNodeReady("n1", "0.8.0");
    const v = readView().nodes.n1;
    expect(v?.phase).toBe("failed");
    expect(v?.message).toBe("rolled back to 0.8.0");
  });

  it("treats build-suffixed equality as the ordered version, same comparator as the route", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    recordNodeReady("n1", "0.9.0-canary");
    expect(readView().nodes.n1?.phase).toBe("done");
  });

  it("records nothing when no update was in flight", () => {
    recordNodeReady("n1", "0.9.0");
    expect(readView().nodes.n1).toBeUndefined();
    expect(hasNonTerminal()).toBe(false);
  });
});

describe("recordNodeDisconnect", () => {
  /**
   * The load-bearing non-behavior: a socket dropping mid-update reads exactly
   * like the node restarting into its new binary AND exactly like a network
   * flap, and inferring `restarting` from it would tell a lie every time it
   * was the flap. The stall clock and the next `ready` are the arbiter.
   */
  it("claims no restart: working stays working across a disconnect", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    nowMs += 60_000;
    recordNodeDisconnect("n1");
    const v = readView().nodes.n1;
    expect(v?.phase).toBe("working");
    expect(v?.message).toBeNull();
    expect(v?.startedAt).toBe(1_000_000);
  });

  it("does not disturb a restarting entry either", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    recordNodeDisconnect("n1");
    expect(readView().nodes.n1?.phase).toBe("restarting");
  });
});

describe("readView — the derived clock", () => {
  it("flips to stalled at exactly STALL_MS and not a millisecond before", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    expect(readView(1_000_000 + STALL_MS - 1).nodes.n1?.phase).toBe("restarting");
    expect(readView(1_000_000 + STALL_MS).nodes.n1?.phase).toBe("stalled");
  });

  it("a stalled entry is still resolvable — the late timeout outcome proves it", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateOutcomeUnknown("n1");
    nowMs += STALL_MS + 1;
    expect(readView().nodes.n1?.phase).toBe("stalled");
    recordNodeReady("n1", "0.9.0");
    expect(readView().nodes.n1?.phase).toBe("done");
  });

  it("terminal entries self-expire: visible until endedAt + TERMINAL_EXPIRE_MS, gone at it", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateSwapped("n1");
    recordNodeReady("n1", "0.9.0");
    const endedAt = readView().nodes.n1?.endedAt ?? 0;
    expect(readView(endedAt + TERMINAL_EXPIRE_MS - 1).nodes.n1).toBeDefined();
    expect(readView(endedAt + TERMINAL_EXPIRE_MS).nodes.n1).toBeUndefined();
  });

  it("a failed entry expires the same way", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    updateRefused("n1", "refused");
    expect(readView(nowMs + TERMINAL_EXPIRE_MS).nodes.n1).toBeUndefined();
  });

  it("a stalled entry expires too, from the moment it stalled", () => {
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    expect(readView(1_000_000 + STALL_MS + TERMINAL_EXPIRE_MS - 1).nodes.n1?.phase).toBe("stalled");
    expect(readView(1_000_000 + STALL_MS + TERMINAL_EXPIRE_MS).nodes.n1).toBeUndefined();
  });
});

describe("hasNonTerminal", () => {
  it("answers the poll gate: false empty, true while live, true while stalled, false when all terminal", () => {
    expect(hasNonTerminal()).toBe(false);
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    expect(hasNonTerminal()).toBe(true);
    nowMs = 1_000_000 + STALL_MS;
    expect(hasNonTerminal()).toBe(true); // stalled still counts — a ready can land
    updateRefused("n1", "refused");
    expect(hasNonTerminal()).toBe(false);
  });

  it("counts the self entry", () => {
    beginSelfUpdate({ from: "1.0.0", to: "1.1.0" });
    expect(hasNonTerminal()).toBe(true);
    resolveSelfUpdate("done");
    expect(hasNonTerminal()).toBe(false);
  });
});

describe("the self entry", () => {
  it("begin and resolve land under their own key, apart from every node", () => {
    beginSelfUpdate({ from: "1.0.0", to: "1.1.0" });
    beginUpdate("n1", { from: "0.8.0", to: "0.9.0" });
    const v = readView();
    expect(v.server?.phase).toBe("working");
    expect(v.nodes.n1?.phase).toBe("working");
    resolveSelfUpdate("failed", "the migration refused to run");
    const v2 = readView();
    expect(v2.server?.phase).toBe("failed");
    expect(v2.server?.message).toBe("the migration refused to run");
    expect(v2.nodes.n1?.phase).toBe("working");
  });

  /**
   * The restart asymmetry (design 2026-09-25): the entry a server update
   * began dies with the process that exits for the manager, so the boot
   * FINALIZES the story by RE-CREATING the terminal entry from the on-disk
   * marker. A page loaded after recovery sees `done` even though the
   * `beginSelfUpdate` call is long gone.
   */
  it("resolve re-creates the entry when the begin did not survive the restart", () => {
    resolveSelfUpdate("done", null, { from: "1.0.0", to: "1.1.0", startedAt: "2026-09-25T00:00:00.000Z" });
    const v = readView();
    expect(v.server).toEqual({
      from: "1.0.0",
      to: "1.1.0",
      startedAt: Date.parse("2026-09-25T00:00:00.000Z"),
      phase: "done",
      message: null,
      endedAt: nowMs,
    });
  });

  it("resolve without a begin or a re-creation source is a no-op", () => {
    resolveSelfUpdate("failed", "detail");
    expect(readView().server).toBeNull();
  });

  it("a terminal self entry does not revive", () => {
    beginSelfUpdate({ from: "1.0.0", to: "1.1.0" });
    resolveSelfUpdate("done");
    nowMs += 1_000;
    resolveSelfUpdate("failed", "late");
    expect(readView().server?.phase).toBe("done");
  });

  it("a re-press of the self update resets the clock, like any node's", () => {
    beginSelfUpdate({ from: "1.0.0", to: "1.1.0" });
    resolveSelfUpdate("failed", "no restart available");
    nowMs += 90_000;
    beginSelfUpdate({ from: "1.0.0", to: "1.1.0" });
    const v = readView().server;
    expect(v?.phase).toBe("working");
    expect(v?.startedAt).toBe(nowMs);
  });
});
