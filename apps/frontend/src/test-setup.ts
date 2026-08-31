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
