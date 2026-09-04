import { describe, expect, it } from "bun:test";
import { attachTouchScroll, gateTouchKeyboard } from "@/lib/terminal-touch-scroll";

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
  const e = new Event(type) as Event & { touches: { clientY: number }[] };
  Object.defineProperty(e, "touches", { value: clientYs.map((y) => ({ clientY: y })), configurable: true });
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

  it("two-finger moves are ignored (pinch/zoom is nobody's business)", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchEvent("touchstart", 100, 120)); // two fingers down
    screen.dispatchEvent(touchEvent("touchmove", 40));
    expect(term.scrolled).toEqual([]);
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

describe("gateTouchKeyboard", () => {
  function gateSetup() {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    root.append(screen, viewport);
    let blurs = 0;
    const term = { textarea: { blur: () => blurs++ } };
    const detach = gateTouchKeyboard(term as never, root, () => true);
    return { root, screen, viewport, blurs: () => blurs, detach };
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

  it("a tap keeps xterm's focus (that is how the keyboard is opened)", () => {
    const { root, screen, blurs, detach } = gateSetup();
    screen.dispatchEvent(pointerDown(100, 300));
    root.dispatchEvent(touchAt("touchmove", 103, 298)); // a finger's tremble
    root.dispatchEvent(new Event("touchend"));
    expect(blurs()).toBe(0);
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
