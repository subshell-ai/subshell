import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { resyncScrollbarToBuffer, scheduleScrollbarResync } from "@/lib/terminal-scrollbar";

/**
 * Terminal stand-ins for the private-path helper. The shape mirrors what the
 * guard actually reads: `_core._viewport.scrollToLine` for the set, public
 * `buffer.active.viewportY` for the position.
 */
function wiredTerm(viewportY: number) {
  const calls: [number, boolean | undefined][] = [];
  const term = {
    buffer: { active: { viewportY } },
    _core: {
      _viewport: {
        scrollToLine(line: number, disableSmoothScroll?: boolean) {
          calls.push([line, disableSmoothScroll]);
        },
      },
    },
  };
  return { term, calls };
}

describe("resyncScrollbarToBuffer", () => {
  it("is a no-op, never a throw, when the private path is missing", () => {
    // A never-opened / differently-shaped terminal: `_viewport` exists only
    // after open(), and any xterm rename drops the chain to undefined.
    expect(() => resyncScrollbarToBuffer({} as unknown as Terminal)).not.toThrow();
    expect(() => resyncScrollbarToBuffer({ _core: {} } as unknown as Terminal)).not.toThrow();
    // Even a viewport without the method is inert — the call is feature-
    // detected, not asserted.
    expect(() => resyncScrollbarToBuffer({ _core: { _viewport: {} } } as unknown as Terminal)).not.toThrow();
  });

  it("re-asserts the TRUE buffer line, absolutely, not via the relative public API", () => {
    const { term, calls } = wiredTerm(42);
    resyncScrollbarToBuffer(term as unknown as Terminal);
    // (42, true): the absolute line the buffer says it is on, with
    // disableSmoothScroll — the form that sets the position NOW and re-keys
    // the viewport's `_latestYDisp` guard field. False would reuse a running
    // smooth-scroll animation and leave the guard stale: the #6172 skip again.
    expect(calls).toEqual([[42, true]]);
  });
});

describe("scheduleScrollbarResync", () => {
  /** Swap rAF for a manual queue; run() drains, restore() ends the test. */
  function fakeFrames() {
    const original = globalThis.requestAnimationFrame;
    const queue: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => queue.push(cb)) as typeof requestAnimationFrame;
    return {
      pending: () => queue.length,
      run() {
        for (const cb of queue.splice(0, queue.length)) cb(0);
      },
      restore() {
        globalThis.requestAnimationFrame = original;
      },
    };
  }

  it("coalesces every resize of one frame into ONE re-assertion, per terminal", () => {
    const a = wiredTerm(10);
    const b = wiredTerm(3);
    const frames = fakeFrames();
    try {
      scheduleScrollbarResync(a.term as unknown as Terminal);
      scheduleScrollbarResync(a.term as unknown as Terminal); // letterbox RO
      scheduleScrollbarResync(a.term as unknown as Terminal); // + settled re-fit
      scheduleScrollbarResync(b.term as unknown as Terminal); // a different pane
      expect(frames.pending()).toBe(2); // one per terminal, never shared
      frames.run();
    } finally {
      frames.restore();
    }
    expect(a.calls).toEqual([[10, true]]);
    expect(b.calls).toEqual([[3, true]]);
  });

  it("re-books after a drained frame: the next resize is not swallowed", () => {
    const { term, calls } = wiredTerm(7);
    const frames = fakeFrames();
    try {
      scheduleScrollbarResync(term as unknown as Terminal);
      frames.run();
      scheduleScrollbarResync(term as unknown as Terminal);
      expect(frames.pending()).toBe(1);
      frames.run();
    } finally {
      frames.restore();
    }
    expect(calls.length).toBe(2);
  });
});

describe("the real terminal keeps buffer and scrollbar in agreement", () => {
  /**
   * The #6172 desync cannot be REPRODUCED under happy-dom: the queueSync
   * skip repairs against `dimensions.css.cell.height`, which the stubbed
   * canvas measures at a fake height and whose refresh callbacks only run
   * under a rendering loop this DOM never drives. So this is the agreement
   * PIN the fix must not break, not a red-first repro: after a write that
   * overflows, a scroll-up into scrollback, and a resize round-trip, the
   * re-assert lands the private viewport's position AND its `_latestYDisp`
   * guard field on the buffer's true line — and moves no buffer state.
   */
  it("resize round-trips keep ydisp, and the resync re-keys the guard field", async () => {
    const term = new Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true });
    const el = document.createElement("div");
    document.body.appendChild(el);
    term.open(el);
    try {
      let feed = "";
      for (let i = 0; i < 60; i++) feed += `line ${i}\r\n`;
      term.write(feed);
      await new Promise<void>((resolve) => term.write("", () => resolve()));

      term.scrollLines(-20); // read up into the scrollback
      const line = term.buffer.active.viewportY;
      expect(line).toBeGreaterThan(0); // genuinely scrolled up, not pinned at bottom

      term.resize(20, 7); // out and back, the resize round-trip that strands it
      term.resize(20, 5);
      expect(term.buffer.active.viewportY).toBe(line); // resize moved no buffer truth

      resyncScrollbarToBuffer(term);
      expect(term.buffer.active.viewportY).toBe(line); // the repair drags nothing

      const core = term as unknown as {
        _core: {
          _viewport: {
            _latestYDisp?: number;
            _scrollableElement: { getScrollPosition(): { scrollTop: number } };
          };
          _renderService: { dimensions: { css: { cell: { height: number } } } };
        };
      };
      const viewport = core._core._viewport;
      // The private proof the call landed where it should: the guard field
      // `queueSync` misuses now equals the buffer's line, so the next resize
      // re-sync takes the true value.
      expect(viewport._latestYDisp).toBe(line);
      const cellHeight = core._core._renderService.dimensions.css.cell.height;
      if (cellHeight > 0) {
        expect(viewport._scrollableElement.getScrollPosition().scrollTop).toBeCloseTo(line * cellHeight, 0);
      }
    } finally {
      term.dispose();
      el.remove();
    }
  });
});
