import { describe, expect, it } from "bun:test";
import {
  attachCopyModeShield,
  attachTouchScroll,
  attachWheelScroll,
  gateTouchKeyboard,
} from "@/lib/terminal-touch-scroll";

/** Minimal Terminal stand-in: only scrollLines matters here. */
function fakeTerm() {
  const scrolled: number[] = [];
  return {
    scrolled,
    scrollLines(n: number) {
      scrolled.push(n);
    },
  };
}

/** Build the touch Event shape the handler reads (happy-dom has no usable
 * TouchEvent constructor here; the handler only needs `touches` + preventDefault).
 * Extra clientY arguments add fingers. */
function touchEvent(type: string, ...clientYs: number[]) {
  const e = new Event(type, { cancelable: true }) as Event & { touches: { clientY: number }[] };
  Object.defineProperty(e, "touches", {
    value: clientYs.map((y) => ({ clientX: 0, clientY: y })),
    configurable: true,
  });
  return e;
}

/** Two-finger event with real coordinates — the pair handler reads x and y
 * of BOTH fingers (direction + pinch detection). */
function touchTwo(type: string, a: [number, number], b: [number, number]) {
  const e = new Event(type, { cancelable: true }) as Event & { touches: { clientX: number; clientY: number }[] };
  Object.defineProperty(e, "touches", {
    value: [
      { clientX: a[0], clientY: a[1] },
      { clientX: b[0], clientY: b[1] },
    ],
    configurable: true,
  });
  return e;
}

function setup() {
  const root = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  root.append(screen);
  const term = fakeTerm();
  const detach = attachTouchScroll(term as never, root, () => true);
  return { term, screen, detach };
}

describe("attachTouchScroll", () => {
  it("swipe up scrolls down through history, one line per row height", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchEvent("touchstart", 300));
    // 60px up at the 18px fallback row height (the fake has no render
    // metrics) = +3 lines (toward the bottom), 6px carried.
    screen.dispatchEvent(touchEvent("touchmove", 240));
    expect(term.scrolled).toEqual([3]);
    detach();
  });

  it("swipe down scrolls into scrollback, carrying the sub-line remainder across moves", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchEvent("touchstart", 100));
    screen.dispatchEvent(touchEvent("touchmove", 115)); // 15px down => 0 lines at 18px, carry -15
    screen.dispatchEvent(touchEvent("touchmove", 122)); // +7 more => carry -22 => -1 line
    expect(term.scrolled).toEqual([-1]);
    detach();
  });

  it("a second finger lifting mid-gesture does not jump the scroll", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchEvent("touchstart", 100, 120)); // two fingers down
    screen.dispatchEvent(touchEvent("touchmove", 40)); // now only one finger
    expect(term.scrolled).toEqual([]);
    detach();
  });

  it("a two-finger vertical pan scrolls the terminal and holds the page still (iPad: it used to scroll the PWA shell)", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchTwo("touchstart", [100, 200], [140, 260]));
    // Both fingers 40px up, same spread (60): a pair pan => 40/18 = 2 lines, carry 4
    const move = touchTwo("touchmove", [100, 160], [140, 220]);
    screen.dispatchEvent(move);
    expect(term.scrolled).toEqual([2]);
    expect(move.defaultPrevented).toBe(true);
    // continued moves keep scrolling off the carry, still preventing default
    const move2 = touchTwo("touchmove", [100, 124], [140, 184]); // another 36px
    screen.dispatchEvent(move2);
    expect(term.scrolled).toEqual([2, 2]); // 36+4 = 40 => 2 lines
    expect(move2.defaultPrevented).toBe(true);
    detach();
  });

  it("a two-finger horizontal swipe never scrolls lines (JS swipe-nav still sees it; the shell must not)", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchTwo("touchstart", [100, 200], [140, 260]));
    const move = touchTwo("touchmove", [160, 202], [200, 262]); // 60px right, ~2px down
    screen.dispatchEvent(move);
    expect(term.scrolled).toEqual([]);
    // consumed (no PWA-shell scroll) but NOT scrolled — touch listeners
    // elsewhere still receive the event, which is all useSwipeNav needs
    expect(move.defaultPrevented).toBe(true);
    // once surrendered, later vertical drift must not resurrect the scroll
    const move2 = touchTwo("touchmove", [162, 140], [202, 200]);
    screen.dispatchEvent(move2);
    expect(term.scrolled).toEqual([]);
    detach();
  });

  it("a pinch (fingers diverging) never scrolls lines (page zoom is off app-wide via user-scalable=no)", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchTwo("touchstart", [100, 200], [140, 260])); // spread 60
    const move = touchTwo("touchmove", [100, 180], [140, 280]); // spread 100, avg unchanged
    screen.dispatchEvent(move);
    expect(term.scrolled).toEqual([]);
    detach();
  });

  it("a SLOW pair pan still commits (deadzone measured from the origin, not per event)", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchTwo("touchstart", [100, 200], [140, 260]));
    // 3px per event — each delta alone is tremor, the total is not.
    // Commit happens at 12px total; a LINE (the fallback row height is 18px)
    // arrives once the drag has travelled a row's worth.
    for (const y of [197, 194, 191, 188, 185, 182, 179, 176]) {
      screen.dispatchEvent(touchTwo("touchmove", [100, y], [140, y + 60]));
    }
    expect(term.scrolled).toEqual([1]); // 24px total at 18px/row => one line
    detach();
  });

  it("a pair pan ending and a fresh single-finger swipe starts clean", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchTwo("touchstart", [100, 200], [140, 260]));
    screen.dispatchEvent(touchTwo("touchmove", [100, 140], [140, 200])); // pair scroll
    screen.dispatchEvent(new Event("touchend"));
    screen.dispatchEvent(touchEvent("touchstart", 300));
    screen.dispatchEvent(touchEvent("touchmove", 240)); // 60px up => 3 lines
    expect(term.scrolled.at(-1)).toBe(3);
    detach();
  });

  it("detaches: moves after detach do nothing", () => {
    const { term, screen, detach } = setup();
    detach();
    screen.dispatchEvent(touchEvent("touchstart", 300));
    screen.dispatchEvent(touchEvent("touchmove", 100));
    expect(term.scrolled).toEqual([]);
  });

  it("no-op on non-touch UIs (desktop stays byte-identical)", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    root.append(screen);
    const term = fakeTerm();
    attachTouchScroll(term as never, root, () => false);
    screen.dispatchEvent(touchEvent("touchstart", 300));
    screen.dispatchEvent(touchEvent("touchmove", 100));
    expect(term.scrolled).toEqual([]);
  });
});

/** Pointer events for the gate: happy-dom has no PointerEvent ctor, and the
 * gate only reads `pointerType` + the coordinates + the dispatch target. */
function pointerDown(x: number, y: number, pointerType = "touch") {
  const e = new Event("pointerdown", { bubbles: true }) as Event & {
    pointerType: string;
    clientX: number;
    clientY: number;
  };
  e.pointerType = pointerType;
  e.clientX = x;
  e.clientY = y;
  return e;
}

function touchAt(type: string, x: number, y: number) {
  const e = new Event(type) as Event & { touches: { clientX: number; clientY: number }[] };
  Object.defineProperty(e, "touches", { value: [{ clientX: x, clientY: y }], configurable: true });
  return e;
}

describe("attachWheelScroll", () => {
  function wheelSetup(opts?: { isTouch?: () => boolean }) {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    root.append(screen, viewport);
    const term = fakeTerm();
    const detach = attachWheelScroll(term as never, root, opts?.isTouch ?? (() => true));
    return { term, screen, viewport, detach };
  }

  /** The shape a trackpad/mouse wheel arrives as; happy-dom has no WheelEvent
   * ctor guarantees, so the fields are attached by hand. */
  function wheel(deltaY: number, deltaMode: 0 | 1 | 2 = 0) {
    const e = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "deltaY", { value: deltaY });
    Object.defineProperty(e, "deltaMode", { value: deltaMode });
    return e;
  }

  it("pixel deltas scroll lines at one row per row-height, carrying the remainder (iPad Magic Keyboard trackpad)", () => {
    const { term, screen, detach } = wheelSetup();
    const e1 = wheel(30);
    screen.dispatchEvent(e1); // 30px at 18px rows => 1 line, carry 12
    expect(term.scrolled).toEqual([1]);
    expect(e1.defaultPrevented).toBe(true); // the PWA shell must not move
    const e2 = wheel(10); // 10+12 => 1 line again, carry 4
    screen.dispatchEvent(e2);
    expect(term.scrolled).toEqual([1, 1]);
    detach();
  });

  it("deltaMode LINE scrolls exactly those lines (Firefox-style)", () => {
    const { term, screen, detach } = wheelSetup();
    screen.dispatchEvent(wheel(3, 1));
    screen.dispatchEvent(wheel(-1, 1));
    expect(term.scrolled).toEqual([3, -1]);
    detach();
  });

  it("a wheel over the native viewport strip is left alone (xterm's own scrollbar)", () => {
    const { term, viewport, detach } = wheelSetup();
    const e = wheel(30);
    viewport.dispatchEvent(e);
    expect(term.scrolled).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    detach();
  });

  it("a wheel xterm already consumed (mouse-reporting apps) is not double-scrolled", () => {
    const { term, screen, detach } = wheelSetup();
    const e = wheel(30);
    e.preventDefault(); // xterm/MouseManager got there first
    screen.dispatchEvent(e);
    expect(term.scrolled).toEqual([]);
    detach();
  });

  it("no-op on non-touch UIs (desktop keeps its native wheel path byte-identical)", () => {
    const { term, screen, detach } = wheelSetup({ isTouch: () => false });
    const e = wheel(30);
    screen.dispatchEvent(e);
    expect(term.scrolled).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    detach();
  });
});

/** A touch event carrying as many live fingers as coordinates given. */
function touchWith(type: string, ...points: [number, number][]) {
  const e = new Event(type) as Event & { touches: { clientX: number; clientY: number }[] };
  Object.defineProperty(e, "touches", {
    value: points.map(([x, y]) => ({ clientX: x, clientY: y })),
    configurable: true,
  });
  return e;
}

describe("gateTouchKeyboard", () => {
  function gateSetup() {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    // xterm 6's real scrollbar: a slider inside `.xterm-scrollbar`, a sibling
    // of the grid rather than anything inside `.xterm-viewport`.
    const scrollbar = document.createElement("div");
    scrollbar.className = "xterm-visible xterm-scrollbar xterm-vertical";
    const slider = document.createElement("div");
    slider.className = "xterm-slider";
    scrollbar.append(slider);
    root.append(screen, viewport, scrollbar);
    let blurs = 0;
    let focuses = 0;
    const term = { textarea: { blur: () => blurs++ }, focus: () => focuses++ };
    const detach = gateTouchKeyboard(term as never, root, () => true);
    return { root, screen, viewport, slider, blurs: () => blurs, focuses: () => focuses, detach };
  }

  it("a scrollbar (viewport) touch un-focuses before the gesture turn ends", async () => {
    const { viewport, blurs, detach } = gateSetup();
    viewport.dispatchEvent(pointerDown(300, 120));
    await Promise.resolve(); // the gate's blur is queued as a microtask
    expect(blurs()).toBe(1);
    detach();
  });

  it("a swipe on the grid un-focuses once past the slop", () => {
    const { root, screen, blurs, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300)); // bubbles to the gate's capture listener
    root.dispatchEvent(touchAt("touchmove", 100, 295)); // inside slop: still a possible tap
    expect(blurs()).toBe(0);
    root.dispatchEvent(touchAt("touchmove", 100, 250)); // 50px up: swipe
    expect(blurs()).toBe(1);
    root.dispatchEvent(touchAt("touchmove", 100, 200)); // later moves do not re-blur
    expect(blurs()).toBe(1);
    detach();
  });

  it("a tap FOCUSES the terminal — xterm never does it itself on touch", () => {
    const { root, screen, blurs, focuses, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchAt("touchmove", 103, 298)); // a finger's tremble
    root.dispatchEvent(touchWith("touchend"));
    expect(blurs()).toBe(0);
    expect(focuses()).toBe(1);
    detach();
  });

  it("a swipe ends without focusing (scrolling must never raise the keyboard)", () => {
    const { root, screen, focuses, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchAt("touchmove", 100, 250));
    root.dispatchEvent(touchWith("touchend"));
    expect(focuses()).toBe(0);
    detach();
  });

  it("a scrollbar drag ends without focusing", () => {
    const { root, viewport, focuses, detach } = gateSetup();
    viewport.dispatchEvent(pointerDown(300, 120));
    root.dispatchEvent(touchWith("touchend"));
    expect(focuses()).toBe(0);
    detach();
  });

  it("xterm 6's own scrollbar counts as the scrollbar — a tap on the slider neither focuses nor keeps focus", async () => {
    // The strip a finger actually lands on is `.xterm-slider` inside
    // `.xterm-scrollbar`; `.xterm-viewport` is still in the DOM but paints
    // underneath, so matching only that let a scrollbar tap type.
    const { root, slider, blurs, focuses, detach } = gateSetup();
    slider.dispatchEvent(pointerDown(385, 300));
    await Promise.resolve();
    expect(blurs()).toBe(1);
    root.dispatchEvent(touchWith("touchend"));
    expect(focuses()).toBe(0);
    detach();
  });

  it("a two-finger gesture never focuses, even when both fingers lift together", () => {
    const { root, screen, focuses, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchWith("touchstart", [100, 300], [140, 360]));
    screen.dispatchEvent(pointerDown(140, 360)); // the second finger's pointerdown
    root.dispatchEvent(touchWith("touchend")); // iOS can report both lifts at once
    expect(focuses()).toBe(0);
    detach();
  });

  it("a cancelled gesture (a call, the app backgrounding) does not focus", () => {
    const { root, screen, focuses, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchWith("touchcancel"));
    expect(focuses()).toBe(0);
    detach();
  });

  it("lifting one of two fingers does not focus, and the rest of the gesture cannot either", () => {
    const { root, screen, focuses, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchWith("touchstart", [100, 300], [140, 360]));
    root.dispatchEvent(touchWith("touchend", [140, 360])); // one finger still down
    expect(focuses()).toBe(0);
    root.dispatchEvent(touchWith("touchend"));
    expect(focuses()).toBe(0);
    detach();
  });

  it("mouse and pen touches the gate not at all (desktop stays byte-identical)", async () => {
    const { root, screen, viewport, blurs, detach } = gateSetup();
    viewport.dispatchEvent(pointerDown(300, 120, "mouse"));
    screen.dispatchEvent(pointerDown(100, 300, "mouse"));
    root.dispatchEvent(touchAt("touchmove", 100, 100));
    await Promise.resolve();
    expect(blurs()).toBe(0);
    detach();
  });

  it("no-op on non-touch UIs", () => {
    const root = document.createElement("div");
    let blurs = 0;
    const detach = gateTouchKeyboard({ textarea: { blur: () => blurs++ } } as never, root, () => false);
    root.dispatchEvent(pointerDown(1, 1));
    expect(blurs).toBe(0);
    detach();
  });
});

/**
 * Copy mode (issue #242): the standdown, then the shield.
 */

describe("copy mode standdown on the scroll/gate stack", () => {
  it("attachTouchScroll: un-shielded standdown — a one-finger swipe neither scrolls nor cancels", () => {
    // The belt, not the composed mechanism: in the app the copy-mode shield
    // stops these touches at the root and this listener never runs during the
    // mode. The standdown is what a direct caller of attachTouchScroll gets.
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    root.append(screen);
    const term = fakeTerm();
    const detach = attachTouchScroll(
      term as never,
      root,
      () => true,
      () => true,
    );
    screen.dispatchEvent(touchEvent("touchstart", 300));
    const move = touchEvent("touchmove", 240);
    screen.dispatchEvent(move);
    expect(term.scrolled).toEqual([]); // no line-scroll
    expect(move.defaultPrevented).toBe(false); // the browser owns the gesture
    detach();
  });

  it("attachTouchScroll: the PAIR path keeps consuming while in copy mode", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    root.append(screen);
    const term = fakeTerm();
    const detach = attachTouchScroll(
      term as never,
      root,
      () => true,
      () => true,
    );
    screen.dispatchEvent(touchTwo("touchstart", [100, 200], [140, 260]));
    const move = touchTwo("touchmove", [100, 140], [140, 200]); // pair pan 60px up
    screen.dispatchEvent(move);
    expect(term.scrolled).toEqual([3]); // 60/18 = 3 lines
    expect(move.defaultPrevented).toBe(true);
    detach();
  });

  it("attachTouchScroll: toggling copy mode back ON mid-swipe does not jump from the stale Y", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    root.append(screen);
    const term = fakeTerm();
    let copyOn = true;
    const detach = attachTouchScroll(
      term as never,
      root,
      () => true,
      () => copyOn,
    );
    screen.dispatchEvent(touchEvent("touchstart", 300));
    screen.dispatchEvent(touchEvent("touchmove", 240)); // copy on: stand down, Y tracked
    copyOn = false;
    screen.dispatchEvent(touchEvent("touchmove", 234)); // 6px from 240 => sub-row, 0 lines
    expect(term.scrolled).toEqual([]);
    detach();
  });

  it("the composed shield+scroll: a gesture handed back mid-drag re-anchors, never flings", () => {
    // Issue 242 review #5, at the composition the unit standdown test cannot
    // reach: the shield swallows the gesture's start, copy mode flips OFF
    // mid-drag past the stale gap, and the scroll listener meets a touchmove
    // with no anchor it trusts. Correct behavior: anchor on that move (zero
    // scroll, not the whole skipped distance), resume normal scrolling after.
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    root.append(screen);
    const term = fakeTerm();
    let copyOn = true;
    let t = 0;
    const now = () => t;
    const detachScroll = attachTouchScroll(
      term as never,
      root,
      () => true,
      () => copyOn,
      now,
    );
    const detachShield = attachCopyModeShield(
      term as never,
      root,
      () => copyOn,
      () => true,
    );
    // Fully-shielded start: the scroll listener sees NOTHING of this gesture.
    screen.dispatchEvent(touchEvent("touchstart", 500));
    t = 10;
    screen.dispatchEvent(touchEvent("touchmove", 410));
    expect(term.scrolled).toEqual([]);
    // Copy mode flips off mid-gesture, after a gap past the stale threshold.
    copyOn = false;
    t = 600;
    const resumed = touchEvent("touchmove", 200); // 210px above where anything was anchored
    screen.dispatchEvent(resumed);
    expect(term.scrolled).toEqual([]); // re-anchored, not flung
    expect(resumed.defaultPrevented).toBe(false); // nothing consumed either
    // From the new anchor the gesture scrolls normally.
    t = 620;
    screen.dispatchEvent(touchEvent("touchmove", 164)); // 36px up => 2 lines
    expect(term.scrolled).toEqual([2]);
    detachShield();
    detachScroll();
  });

  it("gateTouchKeyboard: a tap in copy mode does NOT raise the keyboard, a scrollbar touch still blurs", async () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const scrollbar = document.createElement("div");
    scrollbar.className = "xterm-visible xterm-scrollbar xterm-vertical";
    root.append(screen, scrollbar);
    let blurs = 0;
    let focuses = 0;
    const term = { textarea: { blur: () => blurs++ }, focus: () => focuses++ };
    const detach = gateTouchKeyboard(
      term as never,
      root,
      () => true,
      () => true,
    );
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchWith("touchend"));
    expect(focuses).toBe(0);
    scrollbar.dispatchEvent(pointerDown(385, 300));
    await Promise.resolve();
    expect(blurs).toBe(1); // the blur halves stay (reading never wants the keyboard)
    detach();
  });
});

describe("attachCopyModeShield (issue #242)", () => {
  /** The shape the shield reads: a DOM grid at the origin, fixed metrics, a
   * line with a URL, and a viewportY that keeps the row math honest. */
  function shieldSetup(opts?: { copyMode?: () => boolean; open?: (u: string) => void }) {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const scrollbar = document.createElement("div");
    scrollbar.className = "xterm-visible xterm-scrollbar xterm-vertical";
    root.append(screen, scrollbar);
    // happy-dom's getBoundingClientRect is all-zeros: the grid IS at (0,0).
    const lines: Record<number, string> = { 5: "See https://tap.dev/x done" };
    const term = {
      element: root,
      cols: 40,
      rows: 24,
      dimensions: { css: { cell: { width: 8, height: 16 } } },
      buffer: {
        active: {
          viewportY: 0,
          getLine: (n: number) => ({ translateToString: (_trim: boolean) => lines[n] ?? "" }),
        },
      },
    };
    return { root, screen, scrollbar, term: term as never, copyMode: opts?.copyMode ?? (() => true) };
  }

  /** A touch event the shield reads end-to-end: touches + changedTouches. */
  function shieldTouch(type: string, points: [number, number][], lastLift?: [number, number]) {
    const e = new Event(type, { bubbles: true, cancelable: true }) as Event & {
      touches: { clientX: number; clientY: number }[];
      changedTouches: { clientX: number; clientY: number }[];
    };
    Object.defineProperty(e, "touches", { value: points.map(([x, y]) => ({ clientX: x, clientY: y })) });
    Object.defineProperty(e, "changedTouches", {
      value: (lastLift ? [lastLift] : points).map(([x, y]) => ({ clientX: x, clientY: y })),
    });
    return e;
  }

  function recordingOpen(): { uris: string[]; restore: () => void } {
    const original = window.open;
    const uris: string[] = [];
    window.open = ((url?: string | URL) => {
      uris.push(String(url));
      return null;
    }) as typeof window.open;
    return {
      uris,
      restore: () => {
        window.open = original;
      },
    };
  }

  it("while ON, a one-finger grid touch never reaches the screen's own listeners", () => {
    const { root, screen, term, copyMode } = shieldSetup();
    const detach = attachCopyModeShield(term, root, copyMode, () => true);
    let reached = 0;
    screen.addEventListener("touchstart", () => reached++);
    screen.dispatchEvent(shieldTouch("touchstart", [[40, 88]]));
    expect(reached).toBe(0); // stopPropagation at the root capture — Gesture never sees it
    detach();
  });

  it("a clean tap ON a URL token opens it and cancels the compatibility mouse", () => {
    const { root, screen, term, copyMode } = shieldSetup();
    const detach = attachCopyModeShield(term, root, copyMode, () => true);
    const open = recordingOpen();
    try {
      screen.dispatchEvent(shieldTouch("touchstart", [[44, 88]])); // col 5, row 5: in the URL
      const end = shieldTouch("touchend", [], [44, 88]);
      screen.dispatchEvent(end);
      expect(open.uris).toEqual(["https://tap.dev/x"]);
      expect(end.defaultPrevented).toBe(true); // no mousedown → no focus → no keyboard
    } finally {
      open.restore();
      detach();
    }
  });

  it("a clean tap NOT on a URL does nothing — and above all never opens", () => {
    const { root, screen, term, copyMode } = shieldSetup();
    const detach = attachCopyModeShield(term, root, copyMode, () => true);
    const open = recordingOpen();
    try {
      screen.dispatchEvent(shieldTouch("touchstart", [[8, 88]])); // col 1: "See"
      const end = shieldTouch("touchend", [], [8, 88]);
      screen.dispatchEvent(end);
      expect(open.uris).toEqual([]);
      expect(end.defaultPrevented).toBe(true); // the tap is still cancelled: no keyboard either
    } finally {
      open.restore();
      detach();
    }
  });

  it("a DRAG past the slop is a selection: it opens nothing and cancels nothing", () => {
    const { root, screen, term, copyMode } = shieldSetup();
    const detach = attachCopyModeShield(term, root, copyMode, () => true);
    const open = recordingOpen();
    try {
      screen.dispatchEvent(shieldTouch("touchstart", [[44, 88]])); // starts on the URL…
      screen.dispatchEvent(shieldTouch("touchmove", [[140, 100]])); // …and drags off it
      const end = shieldTouch("touchend", [], [140, 100]);
      screen.dispatchEvent(end);
      expect(open.uris).toEqual([]);
      expect(end.defaultPrevented).toBe(false); // the native selection owns the release
    } finally {
      open.restore();
      detach();
    }
  });

  it("multi-touch passes: the pair scroll path stays live", () => {
    const { root, screen, term, copyMode } = shieldSetup();
    const detach = attachCopyModeShield(term, root, copyMode, () => true);
    let reached = 0;
    screen.addEventListener("touchstart", () => reached++);
    screen.dispatchEvent(
      shieldTouch("touchstart", [
        [40, 88],
        [100, 200],
      ]),
    );
    expect(reached).toBe(1);
    detach();
  });

  it("the scrollbar strip is xterm's, not the shield's", () => {
    const { root, scrollbar, term, copyMode } = shieldSetup();
    const detach = attachCopyModeShield(term, root, copyMode, () => true);
    let reached = 0;
    scrollbar.addEventListener("touchstart", () => reached++);
    scrollbar.addEventListener("pointerdown", () => reached++);
    scrollbar.dispatchEvent(shieldTouch("touchstart", [[385, 88]]));
    const pd = new Event("pointerdown", { bubbles: true });
    scrollbar.dispatchEvent(pd);
    expect(reached).toBe(2);
    detach();
  });

  it("inert while OFF: touches pass, taps are not cancelled (desktop stays byte-identical)", () => {
    const { root, screen, term } = shieldSetup({ copyMode: () => false });
    const detach = attachCopyModeShield(
      term,
      root,
      () => false,
      () => true,
    );
    let reached = 0;
    screen.addEventListener("touchstart", () => reached++);
    screen.dispatchEvent(shieldTouch("touchstart", [[44, 88]]));
    const end = shieldTouch("touchend", [], [44, 88]);
    screen.dispatchEvent(end);
    expect(reached).toBe(1);
    expect(end.defaultPrevented).toBe(false);
    detach();
  });
});
