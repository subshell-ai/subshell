import { afterEach, describe, expect, it } from "bun:test";
import {
  beginPointerSubshellDrag,
  consumePointerDragClick,
  registerPointerDragZone,
  subscribePointerDrag,
} from "@/lib/subshell-pointer-drag";

/**
 * The pointer-event transport for the sidebar drag (iPad PWA, Magic Keyboard
 * trackpad, operator report 2026-10-30): iPadOS never fires `dragstart` from
 * a trackpad press-drag, so the HTML5 transport at `lib/subshell-dnd.ts`
 * stays silent and the gesture falls through to text selection. These tests
 * pin the state machine the components ride: threshold, native yield,
 * single active gesture, zone hit-test, drop, cleanup.
 */

function move(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
}
function up(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: x, clientY: y }));
}
function nativeDragStart(): void {
  window.dispatchEvent(new MouseEvent("dragstart"));
}

function begin(opts: Partial<Parameters<typeof beginPointerSubshellDrag>[0]> = {}): void {
  beginPointerSubshellDrag({
    subshellId: "s-1",
    pointerType: "mouse",
    button: 0,
    clientX: 100,
    clientY: 100,
    ...opts,
  });
}

const rectZone = (x0: number, y0: number, x1: number, y1: number, over: Partial<{ enabled: () => boolean }> = {}) => ({
  contains: (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
  enabled: () => true,
  ...over,
});

describe("beginPointerSubshellDrag", () => {
  afterEach(() => {
    // A running gesture self-clears at pointerup; this covers tests that end
    // mid-flight. Safe to call unconditionally.
    up(-9999, -9999);
  });

  it("ignores touch (native path owns it) and non-primary buttons", () => {
    const seen: unknown[] = [];
    const off = subscribePointerDrag((s) => seen.push(s));
    begin({ pointerType: "touch" });
    move(200, 200);
    begin({ pointerType: "mouse", button: 1 });
    move(300, 300);
    expect(seen).toEqual([]);
    off();
  });

  it("promotes past the threshold and publishes the subshell id", () => {
    const seen: (string | null)[] = [];
    const off = subscribePointerDrag((s) => seen.push(s ? s.subshellId : null));
    begin();
    move(103, 103); // under threshold
    expect(seen).toEqual([]);
    move(120, 120); // promoted
    expect(seen).toEqual(["s-1"]);
    off();
  });

  it("yields to a native dragstart — desktop HTML5 stays byte-identical", () => {
    const seen: (string | null)[] = [];
    const onPromote: string[] = [];
    const off = subscribePointerDrag((s) => seen.push(s ? s.subshellId : null));
    begin({ onPromote: () => onPromote.push("y") });
    nativeDragStart();
    move(400, 400);
    expect(seen).toEqual([]);
    expect(onPromote).toEqual([]);
    off();
  });

  it("drops on the enabled zone under the pointer and ends the gesture", () => {
    const dropped: string[] = [];
    const off = registerPointerDragZone({
      ...rectZone(200, 200, 400, 400),
      onDrop: (id) => dropped.push(id),
    });
    const states: (string | null)[] = [];
    const offS = subscribePointerDrag((s) => states.push(s ? (s.overZone ? "over" : "drag") : null));
    begin();
    move(300, 300);
    up(300, 300);
    expect(dropped).toEqual(["s-1"]);
    // The promote itself hit-tests the point, so the first publish already
    // carries the zone — a ring that appeared a frame late would flicker.
    expect(states).toEqual(["over", null]);
    off();
    offS();
  });

  it("skips a zone that is not accepting, and a pointer-up outside any zone drops nothing", () => {
    const dropped: string[] = [];
    const offA = registerPointerDragZone({
      ...rectZone(0, 0, 1000, 1000, { enabled: () => false }),
      onDrop: (id) => dropped.push(`locked${id}`),
    });
    const offB = registerPointerDragZone({ ...rectZone(200, 200, 400, 400), onDrop: (id) => dropped.push(id) });
    begin();
    move(300, 300); // over the enabled inner zone
    expect(dropped).toEqual([]);
    up(900, 900); // only the disabled zone covers the release point
    expect(dropped).toEqual([]);
    offA();
    offB();
  });

  it("Escape aborts: no drop, gesture ends", () => {
    const dropped: string[] = [];
    const off = registerPointerDragZone({ ...rectZone(0, 0, 500, 500), onDrop: (id) => dropped.push(id) });
    begin();
    move(250, 250);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    up(250, 250);
    expect(dropped).toEqual([]);
    off();
  });

  it("a promoted gesture swallows the trailing click exactly once", () => {
    begin();
    move(500, 500);
    up(500, 500);
    expect(consumePointerDragClick()).toBe(true);
    expect(consumePointerDragClick()).toBe(false);
  });

  it("a click that never promoted does not swallow, and the next pointerdown resets the flag", () => {
    begin();
    up(101, 101); // below threshold
    expect(consumePointerDragClick()).toBe(false);
    begin();
    move(600, 600);
    up(600, 600);
    expect(consumePointerDragClick()).toBe(true);
    begin(); // a fresh gesture starts the click bookkeeping again
    expect(consumePointerDragClick()).toBe(false);
  });

  it("floats a pointer-events-none ghost while promoted and removes it at end", () => {
    const before = document.body.children.length;
    begin({
      createGhost: () => {
        const el = document.createElement("div");
        el.style.pointerEvents = "none";
        return el;
      },
    });
    move(700, 700);
    expect(document.body.children.length).toBe(before + 1);
    up(700, 700);
    expect(document.body.children.length).toBe(before);
  });

  it("suppresses text selection for the life of a promoted gesture", () => {
    begin();
    move(800, 800);
    expect(document.body.style.userSelect).toBe("none");
    up(800, 800);
    expect(document.body.style.userSelect).toBe("");
  });

  it("calls onEnd once, only for a promoted gesture", () => {
    let ends = 0;
    begin({ onEnd: () => (ends += 1) });
    up(101, 101);
    expect(ends).toBe(0);
    begin({ onEnd: () => (ends += 1) });
    move(900, 900);
    up(900, 900);
    expect(ends).toBe(1);
  });
});
