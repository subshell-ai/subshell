import { describe, expect, it } from "bun:test";
import { nodeRow, nodeUpdates, updatesView } from "@/components/__tests__/helpers/updates-view";
import { updatesPollMs } from "@/lib/updates-poll";
import type { UpdateTrackerState } from "@/types/updates";

/** One tracker entry with everything else defaulted. */
function state(over: Partial<UpdateTrackerState>): UpdateTrackerState {
  return {
    from: "0.8.0",
    to: "0.9.1",
    startedAt: "2026-09-25T12:00:00.000Z",
    phase: "working",
    message: null,
    endedAt: null,
    ...over,
  };
}

describe("updatesPollMs", () => {
  it("polls nothing when there is no data and no explicit cadence", () => {
    // The standing rule: this page does not poll by default.
    expect(updatesPollMs(undefined, false)).toBe(false);
    expect(updatesPollMs(updatesView(), false)).toBe(false);
  });

  it("an explicit cadence (a running server job) always wins", () => {
    expect(updatesPollMs(updatesView(), 1_000)).toBe(1_000);
    expect(updatesPollMs(undefined, 1_000)).toBe(1_000);
  });

  it("treats a payload without the tracker fields as nothing moving, never as a crash", () => {
    // A cached or hand-stubbed view can lack the fields entirely (undefined,
    // not null); the poller answers false rather than throwing inside the
    // query scheduler, where the failure would surface as a component crash.
    const legacy = updatesView() as unknown as Record<string, unknown>;
    delete legacy.serverUpdate;
    (legacy.nodes as Record<string, unknown>).rows = [
      Object.fromEntries(Object.entries(nodeRow()).filter(([k]) => k !== "update")),
    ];
    expect(updatesPollMs(legacy as unknown as ReturnType<typeof updatesView>, false)).toBe(false);
  });

  it("polls at 2s while any row's update is live", () => {
    const view = updatesView({
      nodes: nodeUpdates({ rows: [nodeRow({ id: "a", update: state({ phase: "working" }) })] }),
    });
    expect(updatesPollMs(view, false)).toBe(2_000);
  });

  it("stops polling at stalled, because that is the sentence that hands off to a human", () => {
    // stalled is NOT terminal on the server (a late `ready` still resolves
    // it) - but for the POLLER it is terminal: the machine has not come back
    // in two minutes, and 2 s forever against a box that may be offline is
    // the "keep pretending to know" the stall clock exists to stop.
    const view = updatesView({
      nodes: nodeUpdates({ rows: [nodeRow({ id: "a", update: state({ phase: "stalled" }) })] }),
    });
    expect(updatesPollMs(view, false)).toBe(false);
  });

  it("polls while only the server's own update is live", () => {
    expect(updatesPollMs(updatesView({ serverUpdate: state({ phase: "restarting" }) }), false)).toBe(2_000);
  });

  it("stops the moment every entry is done or failed", () => {
    const view = updatesView({
      nodes: nodeUpdates({
        rows: [
          nodeRow({ id: "a", update: state({ phase: "done", endedAt: "2026-09-25T12:01:00.000Z" }) }),
          nodeRow({ id: "b", update: state({ phase: "failed", message: "rolled back", endedAt: "x" }) }),
        ],
      }),
      serverUpdate: state({ phase: "done", endedAt: "y" }),
    });
    expect(updatesPollMs(view, false)).toBe(false);
  });
});
