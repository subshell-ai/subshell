/**
 * Bun test preload: registers happy-dom globals so component tests can
 * render real React trees, then fills the few browser APIs happy-dom lacks
 * that Radix primitives touch (popper measures with ResizeObserver, presence
 * checks matchMedia).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

const globals = globalThis as Record<string, unknown>;
// Tells React 19's act() machinery that the test environment supports it,
// silencing the "not wrapped in act" noise around RTL renders.
globals.IS_REACT_ACT_ENVIRONMENT = true;

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globals.ResizeObserver ??= StubObserver;
globals.IntersectionObserver ??= StubObserver;
if (!globals.matchMedia) {
  globals.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** Cell width (px) the stubbed canvas reports per character. */
const STUB_CELL_WIDTH = 8;

// xterm 6.1 measures its cell size through a canvas 2D context even on the
// DOM renderer path, and asserts the context is non-null (`value must not be
// falsy`). happy-dom defines `getContext` but always answers `null`, so a
// real `new Terminal().open()` cannot mount without this. Only `font` and
// `measureText().width` are ever touched, hence the two-property stub; the
// native context is preferred whenever happy-dom grows a real one.
//
// BOTH canvas flavours need it: xterm picks `new OffscreenCanvas(1, 1)`
// whenever the global exists and only falls back to `<canvas>` otherwise, and
// happy-dom defines OffscreenCanvas — so stubbing HTMLCanvasElement alone
// leaves the branch that actually runs untouched.
function fillCanvas2dContext(ctor: unknown): void {
  const proto = (ctor as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!proto) return;
  const nativeGetContext = proto.getContext as ((this: unknown, id: string) => unknown) | undefined;
  proto.getContext = function (this: unknown, id: string): unknown {
    const native = nativeGetContext?.call(this, id) ?? null;
    if (native) return native;
    if (id !== "2d") return null;
    return { font: "", measureText: (text: string) => ({ width: text.length * STUB_CELL_WIDTH }) };
  };
}
fillCanvas2dContext(globals.OffscreenCanvas);
fillCanvas2dContext(globals.HTMLCanvasElement);
