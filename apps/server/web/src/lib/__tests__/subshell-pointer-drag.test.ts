import { afterEach, describe, expect, it } from "bun:test";
import {
  beginPointerSubshellDrag,
  consumePointerDragClick,
  getPointerDragState,
  registerPointerDragZone,
  resetPointerDragForTests,
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

const SOURCE = document.createElement("div");
// The swallow now keys on release-over-source (round-4 MINOR-2): give the
// detached press anchor a real rect so the geometry branch is exercised.
SOURCE.getBoundingClientRect = () =>
  ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }) as DOMRect;

function begin(opts: Partial<Parameters<typeof beginPointerSubshellDrag>[0]> = {}): void {
  beginPointerSubshellDrag({
    subshellId: "s-1",
    pointerType: "mouse",
    button: 0,
    clientX: 100,
    clientY: 100,
    sourceElement: SOURCE,
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
    resetPointerDragForTests();
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

  // — regression pins for the round-3 review findings —

  it("a dragstart AFTER promotion still cleans up: no stuck selection lock, no stale publish", () => {
    // M1: Chromium/WebKit can deliver the promoting pointermove before the
    // native dragstart on a fast flick. Zeroing `promoted` for the yield must
    // not skip the cleanups the promotion performed.
    const seen: unknown[] = [];
    const off = subscribePointerDrag((s) => seen.push(s));
    let ends = 0;
    begin({ onEnd: () => (ends += 1) });
    move(500, 500); // promotes: user-select none, publish, ghost
    nativeDragStart(); // yields to the native transport
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.querySelectorAll('[aria-hidden="true"]').length).toBe(0);
    expect(seen[seen.length - 1]).toBe(null);
    // The native path owns the gesture: no trailing-click swallow, no onEnd
    // (the row's own dragend disarms the zones).
    expect(consumePointerDragClick(SOURCE)).toBe(false);
    expect(ends).toBe(0);
    off();
  });

  it("a zone armed synchronously catches a flick that releases in the same flush", () => {
    // M2: onPromote arms through React state, which a quick flick's pointerup
    // can outrun. A zone whose enabled() reads the session synchronously
    // (getPointerDragState) must accept that release.
    const dropped: string[] = [];
    const off = registerPointerDragZone({
      contains: (x, y) => x >= 200 && x <= 400 && y >= 200 && y <= 400,
      enabled: () => getPointerDragState()?.subshellId === "s-1",
      onDrop: (id) => dropped.push(id),
    });
    begin();
    move(300, 300); // the promoting move — and the release follows with no
    up(300, 300); // re-render in between, as on a real coalesced flick
    expect(dropped).toEqual(["s-1"]);
    off();
  });

  it("a release over an element outside the zone's subtree drops nothing (z-order)", () => {
    // m3: rect hit-testing alone would let a drop land on a zone that a menu
    // or dialog visually covers.
    const dropped: string[] = [];
    const root = document.createElement("div");
    const overlay = document.createElement("div");
    const off = registerPointerDragZone({
      ...rectZone(0, 0, 500, 500),
      rootElement: () => root,
      onDrop: (id) => dropped.push(id),
    });
    const original = document.elementFromPoint;
    document.elementFromPoint = () => overlay; // topmost at the point: NOT in root
    try {
      begin();
      move(250, 250);
      up(250, 250);
      expect(dropped).toEqual([]);
    } finally {
      document.elementFromPoint = original;
    }
    off();
  });

  it("a throwing zone cannot brick the transport", () => {
    // m2: listeners and the gesture sentinel must clear even when onDrop
    // throws, or every later press early-returns against the stuck gesture.
    const offA = registerPointerDragZone({
      ...rectZone(0, 0, 500, 500),
      onDrop: () => {
        throw new Error("zone exploded");
      },
    });
    begin();
    move(250, 250);
    up(250, 250);
    offA();
    const dropped: string[] = [];
    const offB = registerPointerDragZone({ ...rectZone(0, 0, 500, 500), onDrop: (id) => dropped.push(id) });
    begin();
    move(250, 250);
    up(250, 250);
    expect(dropped).toEqual(["s-1"]);
    offB();
  });

  it("a fresh press force-cancels a stuck session — the lost release cannot phantom-drop", () => {
    // Implicit pointer capture is touch-only, so a mouse button released
    // outside the window delivers no pointerup here and the session never
    // ends on its own. A later press must take over: not only must the new
    // gesture work, the OLD session's listeners must not answer its release
    // (which would drop the stale id wherever the pointer happens to be).
    const dropped: string[] = [];
    const off = registerPointerDragZone({ ...rectZone(200, 200, 400, 400), onDrop: (id) => dropped.push(id) });
    begin({ subshellId: "old" });
    move(900, 900); // promoted — and this release never arrives
    begin({ subshellId: "new" }); // the next press ends the stuck session
    move(300, 300); // the new gesture's own drag
    up(300, 300);
    expect(dropped).toEqual(["new"]);
    off();
  });

  it("publishes only on change, and still clears state at the end", () => {
    // pointermove fires 60–120×/s; zone hosts keep the published object in
    // React state, so a fresh allocation per frame re-renders the whole dock
    // for a pixel of travel. Same id + same zone object must not re-publish,
    // while entering a different zone and the final null always do.
    const seen: (string | null)[] = [];
    const zoneA = registerPointerDragZone({ ...rectZone(0, 0, 400, 400), onDrop: () => {} });
    const zoneB = registerPointerDragZone({ ...rectZone(500, 0, 900, 400), onDrop: () => {} });
    const offS = subscribePointerDrag((s) => seen.push(s ? s.subshellId : null));
    begin(); // origin (100,100)
    move(200, 100); // crosses the threshold over A: the one publish of this batch
    move(201, 100); // same id, same zone
    move(202, 100); // ...nothing new to tell the hosts
    expect(seen).toEqual(["s-1"]);
    move(600, 100); // crossed into B: publish
    expect(seen).toEqual(["s-1", "s-1"]);
    up(600, 100);
    expect(seen[seen.length - 1]).toBe(null);
    offS();
    zoneA();
    zoneB();
  });

  it("the trailing-click swallow is scoped to the source row and dies on the first click", () => {
    // m1: a stale flag must never eat a click on anything else (an unrelated
    // element, a focused link's Enter, a cross-agent row).
    const other = document.createElement("span");
    begin();
    move(900, 900);
    up(900, 900); // promoted, released over nothing
    expect(consumePointerDragClick(other)).toBe(false); // unrelated target…
    expect(consumePointerDragClick(SOURCE)).toBe(false); // …and it dies at once
    begin();
    move(900, 900);
    up(900, 900);
    expect(consumePointerDragClick(SOURCE)).toBe(true); // the row's own click
    expect(consumePointerDragClick(SOURCE)).toBe(false); // exactly once
  });

  it("a refused press (cross-agent gate, non-primary button) still clears a stale swallow", () => {
    begin();
    move(900, 900);
    up(900, 900);
    begin({ enabled: false }); // a cross-agent row's pointerdown: refused…
    expect(consumePointerDragClick(SOURCE)).toBe(false); // …but the stale flag is gone
  });

  it("a release back over the row swallows the click EVEN when a zone took the drop", () => {
    // Round-4 MINOR-2: a row living inside the zero-workspace create zone
    // both drops and (browser-wise) fires its trailing click. The old
    // "swallow only when nothing landed" rule let the click also open the
    // tab on top of the create — a double action.
    const dropped: string[] = [];
    const off = registerPointerDragZone({
      ...rectZone(0, 0, 1000, 1000), // covers the source rect entirely
      onDrop: (id) => dropped.push(id),
    });
    begin();
    move(500, 500);
    up(500, 500); // released back over the row, over the zone
    expect(dropped).toEqual(["s-1"]); // the drop landed…
    expect(consumePointerDragClick(SOURCE)).toBe(true); // …AND the click is swallowed
    off();
  });

  it("a release far from the row arms no swallow (no stale flag for a later Enter)", () => {
    // Round-4 NIT: the old rule armed the flag on any promoted release,
    // stranding it to eat that row's next keyboard Enter (no pointerdown
    // clears it). Only a release inside the source subtree may arm.
    begin();
    move(1500, 1500);
    up(1500, 1500); // outside SOURCE's rect, no zone → nothing lands anywhere
    expect(consumePointerDragClick(SOURCE)).toBe(false);
  });

  it("a throwing zone callback (hitTest or onDrop) cannot brick the transport", () => {
    // Round-4 MINOR-1: hitTest ran OUTSIDE the guarded block, so a throwing
    // enabled()/contains() escaped before finish() — listeners and the
    // gesture sentinel stranded, every later press early-returned.
    const offA = registerPointerDragZone({
      contains: () => {
        throw new Error("contains exploded");
      },
      enabled: () => true,
      onDrop: () => undefined,
    });
    begin();
    move(250, 250);
    up(250, 250); // hitTest throws here — finish must still run
    offA();
    expect(document.body.style.userSelect).toBe("");
    const dropped: string[] = [];
    const offB = registerPointerDragZone({ ...rectZone(0, 0, 500, 500), onDrop: (id) => dropped.push(id) });
    begin(); // not bricked: a fresh gesture works
    move(250, 250);
    up(250, 250);
    expect(dropped).toEqual(["s-1"]);
    offB();
  });
});
