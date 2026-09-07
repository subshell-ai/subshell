/**
 * Bun test preload for the WEB half of this app: registers happy-dom globals so
 * component tests can render real React trees, then fills the few browser APIs
 * happy-dom lacks that Base UI primitives touch (measurement via
 * ResizeObserver, presence checks via matchMedia).
 *
 * Reached only from `ui/bunfig.toml`, i.e. only by `bun test` run with `ui` as
 * the cwd — `bun test src` (the release script) gets no DOM.
 *
 * `apps/frontend`'s equivalent additionally stubs a canvas 2D context because
 * xterm measures its cell size through one. There is no terminal on this page,
 * so that stub is deliberately absent.
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
