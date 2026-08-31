import { describe, expect, it } from "bun:test";
import { attachTouchScroll } from "@/lib/terminal-touch-scroll";

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
