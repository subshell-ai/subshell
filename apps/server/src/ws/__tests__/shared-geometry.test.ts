import { describe, expect, it } from "bun:test";
import { DEFAULT_GRID, MIN_SHARED_COLS, MIN_SHARED_ROWS, resolveSharedGrid } from "@/ws/shared-geometry.js";

/** Terse viewer literal: a capacity with a generated id. */
let seq = 0;
function v(cols: number, rows: number, hidden = false) {
  seq += 1;
  return { id: `v${seq}`, capacity: { cols, rows }, hidden };
}

describe("resolveSharedGrid — smallest wins, per axis", () => {
  it("uses the only viewer's grid when one device is watching", () => {
    expect(resolveSharedGrid([v(120, 40)])).toEqual({ cols: 120, rows: 40 });
  });

  it("shrinks to the smallest viewer so nobody has to clip", () => {
    // A viewer LARGER than the pane letterboxes it and loses nothing; a viewer
    // smaller would have to clip, and clipped rows are content the user
    // cannot see at all.
    expect(resolveSharedGrid([v(120, 40), v(80, 24)])).toEqual({ cols: 80, rows: 24 });
  });

  it("takes each axis independently — a wide-short and a narrow-tall device", () => {
    expect(resolveSharedGrid([v(200, 10), v(40, 60)])).toEqual({ cols: 40, rows: 10 });
  });

  it("is order-independent — the same viewers always give the same grid", () => {
    // THE property that makes several viewers possible: the answer is a pure
    // function of the SET, so the pane cannot oscillate the way last-writer-
    // wins did (the 92x28-vs-86x28 bounce that forced eviction).
    const viewers = [v(100, 30), v(90, 45), v(130, 28)];
    const forward = resolveSharedGrid(viewers);
    const reversed = resolveSharedGrid([...viewers].reverse());
    const shuffled = resolveSharedGrid([viewers[1], viewers[2], viewers[0]] as typeof viewers);
    expect(forward).toEqual({ cols: 90, rows: 28 });
    expect(reversed).toEqual(forward as { cols: number; rows: number });
    expect(shuffled).toEqual(forward as { cols: number; rows: number });
  });

  it("is idempotent: re-resolving its own answer changes nothing", () => {
    const once = resolveSharedGrid([v(120, 40), v(80, 24)]) as { cols: number; rows: number };
    expect(resolveSharedGrid([v(once.cols, once.rows)])).toEqual(once);
  });

  it("ignores a mid-layout viewer rather than shrinking everyone to a 2x1 strip", () => {
    // Observed live: `ws attach … geometry 2x1` — FitAddon's degenerate floor,
    // reported by a client measuring before its layout settled. With several
    // devices that report would otherwise become everyone's pane.
    expect(resolveSharedGrid([v(120, 40), v(2, 1)])).toEqual({ cols: 120, rows: 40 });
  });

  it("ignores anything under the shared floor, on either axis", () => {
    expect(resolveSharedGrid([v(100, 30), v(MIN_SHARED_COLS - 1, 30), v(100, MIN_SHARED_ROWS - 1)])).toEqual({
      cols: 100,
      rows: 30,
    });
  });

  it("keeps a viewer sitting exactly ON the floor", () => {
    expect(resolveSharedGrid([v(100, 30), v(MIN_SHARED_COLS, MIN_SHARED_ROWS)])).toEqual({
      cols: MIN_SHARED_COLS,
      rows: MIN_SHARED_ROWS,
    });
  });

  it("falls back to the LARGEST when every viewer is mid-layout", () => {
    // Sizing to the smallest of a degenerate set would paint into a strip.
    // The largest is the closest thing to a real viewport on offer, and the
    // next settled report supersedes it.
    expect(resolveSharedGrid([v(2, 1), v(10, 3)])).toEqual({ cols: 10, rows: 3 });
  });

  it("reports nothing when no viewer has a usable size at all", () => {
    // Null means "do not resize" — never a 0x0 that would tell the pane to
    // paint into nothing.
    expect(resolveSharedGrid([])).toBeNull();
    expect(resolveSharedGrid([v(0, 0)])).toBeNull();
    expect(resolveSharedGrid([v(-5, 10)])).toBeNull();
    expect(resolveSharedGrid([v(80.5, 24)])).toBeNull();
    expect(resolveSharedGrid([v(Number.NaN, 24)])).toBeNull();
  });

  it("drops only the malformed entries, keeping the rest", () => {
    expect(resolveSharedGrid([v(120, 40), v(Number.NaN, 24), v(90, 30)])).toEqual({ cols: 90, rows: 30 });
  });

  it("has a sane default for callers with nothing to go on", () => {
    // tmux births a detached window at 80x24; the fallback matches so a pane
    // nobody has measured is not a surprise.
    expect(DEFAULT_GRID).toEqual({ cols: 80, rows: 24 });
  });
});

describe("hidden viewers do not hold the pane down", () => {
  it("ignores a hidden viewer, however small", () => {
    // A backgrounded tab is not being rendered at all — no rAF, no
    // ResizeObserver — so it cannot even re-fit until it is shown. Letting it
    // pin everyone else's terminal to phone size, with nothing on screen to
    // explain why, is the worst kind of spooky action at a distance.
    expect(resolveSharedGrid([v(120, 40), v(60, 20, true)])).toEqual({ cols: 120, rows: 40 });
  });

  it("counts it again the moment it is shown", () => {
    expect(resolveSharedGrid([v(120, 40), v(60, 20, false)])).toEqual({ cols: 60, rows: 20 });
  });

  it("uses the hidden ones when EVERY viewer is hidden", () => {
    // Something has to size the pane, and the last thing anyone looked at
    // beats an arbitrary default.
    expect(resolveSharedGrid([v(120, 40, true), v(60, 20, true)])).toEqual({ cols: 60, rows: 20 });
  });

  it("treats an unspecified `hidden` as visible", () => {
    expect(resolveSharedGrid([{ id: "a", capacity: { cols: 60, rows: 20 } }, v(120, 40)])).toEqual({
      cols: 60,
      rows: 20,
    });
  });
});

describe("a pinned viewer decides alone", () => {
  it("uses the pinned viewer's grid, ignoring smaller ones", () => {
    const laptop = v(120, 40);
    const phone = v(60, 20);
    expect(resolveSharedGrid([laptop, phone], { mode: "pinned", pinnedViewerId: laptop.id })).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  it("uses the pinned viewer even when it is the SMALLEST", () => {
    // Pinning is an instruction, not a hint: "size to my phone" is a thing an
    // operator may legitimately want.
    const phone = v(60, 20);
    expect(resolveSharedGrid([v(120, 40), phone], { mode: "pinned", pinnedViewerId: phone.id })).toEqual({
      cols: 60,
      rows: 20,
    });
  });

  it("keeps the pin while the pinned device is merely hidden", () => {
    // The hidden rule is a guess about intent; a pin is the operator stating
    // it, so backgrounding the pinned screen must not silently hand the pane
    // to something else.
    const pinned = v(120, 40, true);
    expect(resolveSharedGrid([pinned, v(60, 20)], { mode: "pinned", pinnedViewerId: pinned.id })).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  it("falls back to auto when the pinned device has gone", () => {
    // Freezing the pane at a departed viewer's size would be the ghost-viewer
    // bug all over again.
    expect(resolveSharedGrid([v(120, 40), v(60, 20)], { mode: "pinned", pinnedViewerId: "not-here" })).toEqual({
      cols: 60,
      rows: 20,
    });
  });

  it("ignores a pin under auto mode", () => {
    const laptop = v(120, 40);
    expect(resolveSharedGrid([laptop, v(60, 20)], { mode: "auto", pinnedViewerId: laptop.id })).toEqual({
      cols: 60,
      rows: 20,
    });
  });

  it("still answers nothing when the pinned viewer never reported a size", () => {
    expect(resolveSharedGrid([{ id: "p", capacity: null }], { mode: "pinned", pinnedViewerId: "p" })).toBeNull();
  });
});
