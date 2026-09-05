import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useDrag } from "@use-gesture/react";
import { type RefObject, useRef } from "react";
import { SWIPE_DRAG_CONFIG, useSwipeNav } from "@/hooks/use-swipe-nav";
import { SWIPE_MIN_DX } from "@/lib/swipe-nav";

/**
 * A swipe zone with a focusable child, mirroring the real page: the terminal's
 * hidden textarea lives INSIDE the zone, so every key it receives passes
 * through the zone's listeners.
 */
function Zone({ onPrev, onNext }: { onPrev: () => void; onNext: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSwipeNav(ref, { onPrev, onNext });
  return (
    <div ref={ref} data-testid="zone">
      <textarea data-testid="terminal-input" />
    </div>
  );
}

/** Drives the REAL config through a bare `useDrag`, recording what it sees. */
function Spy({ config, log }: { config: typeof SWIPE_DRAG_CONFIG; log: (movementX: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDrag(({ movement: [mx] }) => log(mx), config(ref as RefObject<HTMLElement | null>, true));
  return (
    <div ref={ref} data-testid="zone">
      <textarea data-testid="terminal-input" />
    </div>
  );
}

const arrow = (el: Element, type: string, key = "ArrowRight", shiftKey = false) =>
  el.dispatchEvent(new KeyboardEvent(type, { key, shiftKey, bubbles: true }));

describe("useSwipeNav — a keyboard must not drive a touch swipe", () => {
  afterEach(cleanup);

  it("arrow keys produce NO drag movement at all", () => {
    // The bug: @use-gesture's drag has keyboard support on by default, so each
    // arrow keydown reaching the zone added ±10px to the gesture's movement
    // and ACCUMULATED. Nine ArrowRight presses measured movement.x = 87, past
    // the 70px commit threshold — so moving the cursor along an input line
    // walked the viewport sideways and then navigated to another subshell.
    // This is the assertion that fails without `keys: false`; the navigation
    // assertions below are downstream of an edge guard that can mask it.
    const seen: number[] = [];
    const view = render(<Spy config={SWIPE_DRAG_CONFIG} log={(mx) => seen.push(mx)} />);
    const input = view.getByTestId("terminal-input");

    for (let i = 0; i < 12; i += 1) arrow(input, "keydown");
    arrow(input, "keyup");

    expect(seen).toEqual([]);
    // Guard the guard: 12 presses at the library's 10px default would have
    // cleared the commit threshold several times over.
    expect(12 * 10).toBeGreaterThan(SWIPE_MIN_DX);
  });

  it("does not navigate when arrow keys are pressed in the terminal", () => {
    const calls = { prev: 0, next: 0 };
    const view = render(<Zone onPrev={() => (calls.prev += 1)} onNext={() => (calls.next += 1)} />);
    const input = view.getByTestId("terminal-input");

    for (let i = 0; i < 12; i += 1) {
      arrow(input, "keydown");
      arrow(input, "keyup");
    }
    expect(calls).toEqual({ prev: 0, next: 0 });
  });

  it("does not navigate when an arrow key is held down (auto-repeat)", () => {
    const calls = { prev: 0, next: 0 };
    const view = render(<Zone onPrev={() => (calls.prev += 1)} onNext={() => (calls.next += 1)} />);
    const input = view.getByTestId("terminal-input");

    for (let i = 0; i < 20; i += 1) arrow(input, "keydown", "ArrowLeft");
    arrow(input, "keyup", "ArrowLeft");
    expect(calls).toEqual({ prev: 0, next: 0 });
  });

  it("does not navigate on Shift+Arrow, which carried a 10x displacement factor", () => {
    // `factor = event.shiftKey ? 10 : ...` — one Shift+Arrow was 100px, over
    // the threshold on its own.
    const calls = { prev: 0, next: 0 };
    const view = render(<Zone onPrev={() => (calls.prev += 1)} onNext={() => (calls.next += 1)} />);
    const input = view.getByTestId("terminal-input");

    arrow(input, "keydown", "ArrowRight", true);
    arrow(input, "keyup", "ArrowRight", true);
    expect(calls).toEqual({ prev: 0, next: 0 });
  });

  it("STILL navigates on a real touch drag — the fix must not disable the feature", () => {
    // The counter-check every one of the assertions above needs: they would
    // all pass just as happily if `keys: false` had switched the whole gesture
    // off. Only touch may drive it, and touch must still drive it.
    const calls = { prev: 0, next: 0 };
    const view = render(<Zone onPrev={() => (calls.prev += 1)} onNext={() => (calls.next += 1)} />);
    const zone = view.getByTestId("zone");
    const touch = (type: string, x: number) =>
      zone.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "touch",
          clientX: x,
          clientY: 200,
          buttons: 1,
          bubbles: true,
        }),
      );

    touch("pointerdown", 300);
    for (let x = 290; x >= 150; x -= 20) touch("pointermove", x); // 150px leftward
    touch("pointerup", 150);

    expect(calls).toEqual({ prev: 0, next: 1 }); // left swipe = next
  });

  it("leaves the zone untransformed after arrow keys — no creeping viewport", () => {
    const view = render(<Zone onPrev={() => {}} onNext={() => {}} />);
    const input = view.getByTestId("terminal-input");
    for (let i = 0; i < 12; i += 1) arrow(input, "keydown");
    expect(view.getByTestId("zone").style.transform).toBe("");
  });
});
