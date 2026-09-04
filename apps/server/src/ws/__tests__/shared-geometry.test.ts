import { describe, expect, it } from "bun:test";
import { DEFAULT_GRID, MIN_SHARED_COLS, MIN_SHARED_ROWS, resolveSharedGrid } from "@/ws/shared-geometry.js";

describe("resolveSharedGrid — smallest wins, per axis", () => {
  it("uses the only viewer's grid when one device is watching", () => {
    expect(resolveSharedGrid([{ cols: 120, rows: 40 }])).toEqual({ cols: 120, rows: 40 });
  });

  it("shrinks to the smallest viewer so nobody has to clip", () => {
    // A viewer LARGER than the pane letterboxes it and loses nothing; a viewer
    // smaller would have to clip, and clipped rows are content the user
    // cannot see at all.
    expect(
      resolveSharedGrid([
        { cols: 120, rows: 40 },
        { cols: 80, rows: 24 },
      ]),
    ).toEqual({ cols: 80, rows: 24 });
  });

  it("takes each axis independently — a wide-short and a narrow-tall device", () => {
    expect(
      resolveSharedGrid([
        { cols: 200, rows: 10 },
        { cols: 40, rows: 60 },
      ]),
    ).toEqual({ cols: 40, rows: 10 });
  });

  it("is order-independent — the same viewers always give the same grid", () => {
    // THE property that makes several viewers possible: the answer is a pure
    // function of the SET, so the pane cannot oscillate the way last-writer-
    // wins did (the 92x28-vs-86x28 bounce that forced eviction).
    const viewers = [
      { cols: 100, rows: 30 },
      { cols: 90, rows: 45 },
      { cols: 130, rows: 28 },
    ];
    const forward = resolveSharedGrid(viewers);
    const reversed = resolveSharedGrid([...viewers].reverse());
    const shuffled = resolveSharedGrid([viewers[1], viewers[2], viewers[0]] as typeof viewers);
    expect(forward).toEqual({ cols: 90, rows: 28 });
    expect(reversed).toEqual(forward as { cols: number; rows: number });
    expect(shuffled).toEqual(forward as { cols: number; rows: number });
  });

  it("is idempotent: re-resolving its own answer changes nothing", () => {
    const once = resolveSharedGrid([
      { cols: 120, rows: 40 },
      { cols: 80, rows: 24 },
    ]);
    expect(resolveSharedGrid([once as { cols: number; rows: number }])).toEqual(once as { cols: number; rows: number });
  });

  it("ignores a mid-layout viewer rather than shrinking everyone to a 2x1 strip", () => {
    // Observed live: `ws attach … geometry 2x1` — FitAddon's degenerate floor,
    // reported by a client measuring before its layout settled. With several
    // devices that report would otherwise become everyone's pane.
    expect(
      resolveSharedGrid([
        { cols: 120, rows: 40 },
        { cols: 2, rows: 1 },
      ]),
    ).toEqual({ cols: 120, rows: 40 });
  });

  it("ignores anything under the shared floor, on either axis", () => {
    expect(
      resolveSharedGrid([
        { cols: 100, rows: 30 },
        { cols: MIN_SHARED_COLS - 1, rows: 30 },
        { cols: 100, rows: MIN_SHARED_ROWS - 1 },
      ]),
    ).toEqual({ cols: 100, rows: 30 });
  });

  it("keeps a viewer sitting exactly ON the floor", () => {
    expect(
      resolveSharedGrid([
        { cols: 100, rows: 30 },
        { cols: MIN_SHARED_COLS, rows: MIN_SHARED_ROWS },
      ]),
    ).toEqual({ cols: MIN_SHARED_COLS, rows: MIN_SHARED_ROWS });
  });

  it("falls back to the LARGEST when every viewer is mid-layout", () => {
    // Sizing to the smallest of a degenerate set would paint into a strip.
    // The largest is the closest thing to a real viewport on offer, and the
    // next settled report supersedes it.
    expect(
      resolveSharedGrid([
        { cols: 2, rows: 1 },
        { cols: 10, rows: 3 },
      ]),
    ).toEqual({ cols: 10, rows: 3 });
  });

  it("reports nothing when no viewer has a usable size at all", () => {
    // Null means "do not resize" — never a 0x0 that would tell the pane to
    // paint into nothing.
    expect(resolveSharedGrid([])).toBeNull();
    expect(resolveSharedGrid([{ cols: 0, rows: 0 }])).toBeNull();
    expect(resolveSharedGrid([{ cols: -5, rows: 10 }])).toBeNull();
    expect(resolveSharedGrid([{ cols: 80.5, rows: 24 }])).toBeNull();
    expect(resolveSharedGrid([{ cols: Number.NaN, rows: 24 }])).toBeNull();
  });

  it("drops only the malformed entries, keeping the rest", () => {
    expect(
      resolveSharedGrid([
        { cols: 120, rows: 40 },
        { cols: Number.NaN, rows: 24 },
        { cols: 90, rows: 30 },
      ]),
    ).toEqual({ cols: 90, rows: 30 });
  });

  it("has a sane default for callers with nothing to go on", () => {
    // tmux births a detached window at 80x24; the fallback matches so a pane
    // nobody has measured is not a surprise.
    expect(DEFAULT_GRID).toEqual({ cols: 80, rows: 24 });
  });
});
