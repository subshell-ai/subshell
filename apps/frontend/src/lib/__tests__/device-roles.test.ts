import { describe, expect, it } from "bun:test";
import type { ViewerPresence } from "@internal/subshell-protocol";
import { describeDevices, roleLabel } from "@/lib/device-roles";
import type { ViewersState } from "@/lib/use-subshell-ws";

/** A viewer literal; `since` ascends with the id so ordering is predictable. */
function viewer(id: string, cols: number | null, rows = 0, over: Partial<ViewerPresence> = {}): ViewerPresence {
  return {
    id,
    label: id,
    capacity: cols === null ? null : { cols, rows },
    since: `2026-09-04T10:00:${id.padStart(2, "0")}.000Z`,
    canInput: true,
    hidden: false,
    ...over,
  };
}

function state(viewers: ViewerPresence[], over: Partial<ViewersState> = {}): ViewersState {
  return { you: viewers[0]?.id ?? "", viewers, sizing: { mode: "auto", pinnedViewerId: null }, ...over };
}

describe("describeDevices", () => {
  it("names the device holding each axis", () => {
    // The question the list exists to answer: a 4K monitor showing an
    // 80-column pane, and the reason is a phone in another room.
    const report = describeDevices(state([viewer("10", 200, 60), viewer("20", 80, 24)]));
    expect(report.grid).toEqual({ cols: 80, rows: 24 });
    expect(report.rows.map((r) => [r.viewer.id, r.role])).toEqual([
      ["10", "spare"],
      ["20", "size"],
    ]);
  });

  it("splits the blame when two devices constrain one axis each", () => {
    const report = describeDevices(state([viewer("10", 200, 10), viewer("20", 40, 60)]));
    expect(report.grid).toEqual({ cols: 40, rows: 10 });
    expect(report.rows.map((r) => r.role)).toEqual(["height", "width"]);
  });

  it("calls a backgrounded device hidden, not the constraint", () => {
    // It takes no part in sizing, so blaming it would send the user to
    // un-background the one thing that would make the pane SMALLER.
    const report = describeDevices(state([viewer("10", 120, 40), viewer("20", 40, 10, { hidden: true })]));
    expect(report.grid).toEqual({ cols: 120, rows: 40 });
    expect(report.rows.map((r) => r.role)).toEqual(["size", "hidden"]);
  });

  it("marks a pinned device as pinned even while it is hidden", () => {
    // Pinning is the operator overriding the hidden rule on purpose; showing
    // it as "hidden" would hide the very thing deciding the size.
    const viewers = [viewer("10", 120, 40, { hidden: true }), viewer("20", 40, 10)];
    const report = describeDevices(state(viewers, { sizing: { mode: "pinned", pinnedViewerId: "10" } }));
    expect(report.grid).toEqual({ cols: 120, rows: 40 });
    expect(report.rows.map((r) => r.role)).toEqual(["pinned", "spare"]);
  });

  it("stays quiet while every device is still measuring", () => {
    // The degenerate fallback is a stopgap the next settled report replaces;
    // pointing at a device would be blaming it for a transient.
    const report = describeDevices(state([viewer("10", 2, 1), viewer("20", 5, 2)]));
    expect(report.settled).toBe(false);
    expect(report.rows.every((r) => r.role === "spare")).toBe(true);
  });

  it("puts this device first, then oldest attach first", () => {
    // Stable order: the list must not reshuffle as devices resize, or the row
    // under the user's cursor changes out from under the click.
    const viewers = [viewer("10", 120, 40), viewer("20", 100, 30), viewer("30", 90, 30)];
    const report = describeDevices(state(viewers, { you: "30" }));
    expect(report.rows.map((r) => r.viewer.id)).toEqual(["30", "10", "20"]);
    expect(report.rows[0].you).toBe(true);
  });

  it("survives a viewer that has not reported a size yet", () => {
    const report = describeDevices(state([viewer("10", null), viewer("20", 80, 24)]));
    expect(report.grid).toEqual({ cols: 80, rows: 24 });
    expect(report.rows.map((r) => r.role)).toEqual(["spare", "size"]);
  });

  it("has no grid at all when nobody has reported one", () => {
    const report = describeDevices(state([viewer("10", null), viewer("20", null)]));
    expect(report.grid).toBeNull();
    expect(report.settled).toBe(false);
  });
});

describe("roleLabel", () => {
  it("says nothing for a device with room to spare", () => {
    // Labelling every non-constraining device turns the list into noise.
    expect(roleLabel("spare")).toBeNull();
  });

  it("labels every role that explains something", () => {
    expect(["pinned", "size", "width", "height", "hidden"].map((r) => roleLabel(r as "pinned"))).toEqual([
      "pinned",
      "sets size",
      "sets width",
      "sets height",
      "hidden",
    ]);
  });
});

describe("describeDevices agrees with the server about who gets a say", () => {
  it("does not blame a read-only viewer for a size it is not causing", () => {
    // The server excludes a `view` grantee from the top rung, so the pane is
    // the OWNER's size. A list that forgot `canInput` re-admitted the guest,
    // reported a pane size that was never applied, labelled the guest "sets
    // size", and offered a pin that looked broken. The explanation has to
    // read every field the rule reads.
    const owner = viewer("10", 120, 40);
    const guest = viewer("20", 50, 16, { canInput: false });
    const report = describeDevices(state([owner, guest]));
    expect(report.grid).toEqual({ cols: 120, rows: 40 });
    expect(report.rows.map((r) => [r.viewer.id, r.role])).toEqual([
      ["10", "size"],
      ["20", "spare"],
    ]);
  });

  it("still explains a pane sized for a read-only viewer watching alone", () => {
    const guest = viewer("10", 50, 16, { canInput: false });
    const report = describeDevices(state([guest]));
    expect(report.grid).toEqual({ cols: 50, rows: 16 });
    expect(report.rows[0].role).toBe("size");
  });
});
