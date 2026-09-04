import { describe, expect, it } from "bun:test";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  type BoxInsets,
  boxForGrid,
  type CellSize,
  DEFAULT_SCROLLBAR_WIDTH_PX,
  gridForBox,
  gridOverflowsBox,
  scrollbarReserve,
} from "@/lib/terminal-geometry";

/**
 * Drives the REAL shipped FitAddon.
 *
 * `activate(terminal)` is a bare assignment (`this._terminal = e`), and
 * `proposeDimensions` only reads `element`, `element.parentElement`,
 * `dimensions.css.cell` and `options` — so a terminal-shaped literal exercises
 * the actual arithmetic without a canvas, a WebGL context or a real Terminal.
 * That is the point: this pins our copy of the formula to the dependency, so a
 * `@xterm/addon-fit` upgrade that moves it fails here instead of silently
 * re-wrapping every long line by a column.
 */
function proposeWithRealFitAddon(args: {
  box: { width: number; height: number };
  cell: CellSize;
  padding?: { top: number; right: number; bottom: number; left: number };
  options?: Record<string, unknown>;
}): { cols: number; rows: number } | undefined {
  const parent = document.createElement("div");
  parent.style.width = `${args.box.width}px`;
  parent.style.height = `${args.box.height}px`;
  const element = document.createElement("div");
  const pad = args.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  element.style.paddingTop = `${pad.top}px`;
  element.style.paddingRight = `${pad.right}px`;
  element.style.paddingBottom = `${pad.bottom}px`;
  element.style.paddingLeft = `${pad.left}px`;
  parent.appendChild(element);
  document.body.appendChild(parent);

  const fit = new FitAddon();
  fit.activate({
    element,
    dimensions: { css: { cell: { width: args.cell.width, height: args.cell.height } } },
    options: args.options ?? { scrollback: 5000 },
  } as unknown as Terminal);
  try {
    return fit.proposeDimensions();
  } finally {
    parent.remove();
  }
}

const insetsFor = (
  options: Record<string, unknown>,
  padding = { top: 0, right: 0, bottom: 0, left: 0 },
): BoxInsets => ({
  padX: padding.left + padding.right,
  padY: padding.top + padding.bottom,
  reserve: scrollbarReserve(options),
});

describe("gridForBox — pinned to the real FitAddon", () => {
  const boxes = [
    { width: 800, height: 600 },
    { width: 1440, height: 900 },
    { width: 375, height: 667 }, // phone portrait
    { width: 667, height: 375 }, // phone landscape
    { width: 101, height: 53 }, // awkward primes
  ];
  const cells: CellSize[] = [
    { width: 8, height: 17 },
    { width: 7.7, height: 18 }, // fractional, the common real case
    { width: 12.5, height: 27.5 },
  ];

  for (const box of boxes) {
    for (const cell of cells) {
      it(`agrees for a ${box.width}x${box.height} box at ${cell.width}x${cell.height} cells`, () => {
        const options = { scrollback: 5000 };
        const theirs = proposeWithRealFitAddon({ box, cell, options });
        const ours = gridForBox(box, cell, insetsFor(options));
        expect(ours).toEqual(theirs as { cols: number; rows: number });
      });
    }
  }

  it("agrees when the terminal element carries padding", () => {
    const padding = { top: 4, right: 6, bottom: 4, left: 6 };
    const options = { scrollback: 5000 };
    const box = { width: 900, height: 500 };
    const cell = { width: 7.7, height: 18 };
    const theirs = proposeWithRealFitAddon({ box, cell, padding, options });
    expect(gridForBox(box, cell, insetsFor(options, padding))).toEqual(theirs as { cols: number; rows: number });
  });

  it("agrees when scrollback is 0 (no scrollbar, so no reserve)", () => {
    const options = { scrollback: 0 };
    const box = { width: 800, height: 600 };
    const cell = { width: 8, height: 17 };
    const theirs = proposeWithRealFitAddon({ box, cell, options });
    // Proof the reserve actually moved: 14px back is at least one more column.
    expect(theirs?.cols).toBeGreaterThan(
      (proposeWithRealFitAddon({ box, cell, options: { scrollback: 5000 } }) as { cols: number }).cols,
    );
    expect(gridForBox(box, cell, insetsFor(options))).toEqual(theirs as { cols: number; rows: number });
  });

  it("agrees when the scrollbar is hidden or re-widthed", () => {
    const box = { width: 800, height: 600 };
    const cell = { width: 8, height: 17 };
    for (const options of [
      { scrollback: 5000, scrollbar: { showScrollbar: false } },
      { scrollback: 5000, scrollbar: { width: 20 } },
    ]) {
      const theirs = proposeWithRealFitAddon({ box, cell, options });
      expect(gridForBox(box, cell, insetsFor(options))).toEqual(theirs as { cols: number; rows: number });
    }
  });

  it("clamps to FitAddon's 2x1 floor for a degenerate box", () => {
    const options = { scrollback: 5000 };
    const box = { width: 10, height: 1 };
    const cell = { width: 8, height: 17 };
    const theirs = proposeWithRealFitAddon({ box, cell, options });
    expect(gridForBox(box, cell, insetsFor(options))).toEqual(theirs as { cols: number; rows: number });
    expect(theirs).toEqual({ cols: 2, rows: 1 });
  });

  it("reports nothing when the cell has not been measured yet", () => {
    // FitAddon bails on a 0 cell rather than proposing NaN/Infinity; so do we,
    // because a 0-cell proposal would reach tmux as a 2x1 resize.
    expect(gridForBox({ width: 800, height: 600 }, { width: 0, height: 17 }, insetsFor({}))).toBeNull();
    expect(gridForBox({ width: 800, height: 600 }, { width: 8, height: 0 }, insetsFor({}))).toBeNull();
  });
});

describe("scrollbarReserve", () => {
  it("defaults to 14px when scrollback is on and the scrollbar is shown", () => {
    expect(scrollbarReserve({ scrollback: 5000 })).toBe(DEFAULT_SCROLLBAR_WIDTH_PX);
    expect(scrollbarReserve({})).toBe(DEFAULT_SCROLLBAR_WIDTH_PX);
  });

  it("reclaims the pixels when no scrollbar can appear", () => {
    expect(scrollbarReserve({ scrollback: 0 })).toBe(0);
    expect(scrollbarReserve({ scrollback: 5000, scrollbar: { showScrollbar: false } })).toBe(0);
  });

  it("honours an explicit width", () => {
    expect(scrollbarReserve({ scrollback: 5000, scrollbar: { width: 20 } })).toBe(20);
  });
});

describe("boxForGrid — the inverse that makes fitting idempotent", () => {
  const insets = { padX: 0, padY: 0, reserve: DEFAULT_SCROLLBAR_WIDTH_PX };

  it("round-trips every grid back to itself, fractional cells included", () => {
    // This is the property the whole design rests on: pin the container to
    // boxForGrid(G) and FitAddon proposes exactly G, so fit() never resizes
    // and the client never asks the server for a different size.
    const cells: CellSize[] = [
      { width: 8, height: 17 },
      { width: 7.7, height: 18 },
      { width: 12.5, height: 27.5 },
      { width: 6.0166, height: 15.4 },
    ];
    for (const cell of cells) {
      for (const cols of [2, 3, 40, 80, 92, 121, 240]) {
        for (const rows of [1, 2, 13, 24, 28, 60]) {
          const box = boxForGrid({ cols, rows }, cell, insets);
          expect(gridForBox(box, cell, insets)).toEqual({ cols, rows });
        }
      }
    }
  });

  it("round-trips through the REAL FitAddon too, not just our copy", () => {
    const cell = { width: 7.7, height: 18 };
    const options = { scrollback: 5000 };
    for (const grid of [
      { cols: 51, rows: 13 },
      { cols: 92, rows: 28 },
      { cols: 45, rows: 24 },
    ]) {
      const box = boxForGrid(grid, cell, insetsFor(options));
      expect(proposeWithRealFitAddon({ box, cell, options })).toEqual(grid);
    }
  });

  it("adds the padding and the reserve back", () => {
    const box = boxForGrid({ cols: 10, rows: 2 }, { width: 8, height: 17 }, { padX: 12, padY: 8, reserve: 14 });
    expect(box).toEqual({ width: 10 * 8 + 12 + 14, height: 2 * 17 + 8 });
  });
});

describe("gridOverflowsBox", () => {
  const cell = { width: 8, height: 17 };
  const insets = { padX: 0, padY: 0, reserve: DEFAULT_SCROLLBAR_WIDTH_PX };

  it("is false when the grid fits — the ordinary single-viewer case", () => {
    expect(gridOverflowsBox({ cols: 80, rows: 24 }, { width: 1440, height: 900 }, cell, insets)).toBe(false);
  });

  it("is true when another device's grid is wider or taller than this viewport", () => {
    expect(gridOverflowsBox({ cols: 200, rows: 24 }, { width: 400, height: 900 }, cell, insets)).toBe(true);
    expect(gridOverflowsBox({ cols: 20, rows: 90 }, { width: 400, height: 300 }, cell, insets)).toBe(true);
  });

  it("is false at exactly the box produced by boxForGrid (the boundary)", () => {
    const grid = { cols: 45, rows: 24 };
    expect(gridOverflowsBox(grid, boxForGrid(grid, cell, insets), cell, insets)).toBe(false);
  });
});
