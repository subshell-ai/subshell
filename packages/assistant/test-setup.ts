/**
 * Bun test preload for this package's component tests: registers happy-dom
 * globals so tests can render real React trees, then fills the few browser
 * APIs happy-dom lacks that Base UI primitives touch (measurement via
 * ResizeObserver, presence checks via matchMedia).
 *
 * Ported verbatim from `apps/client/desktop/ui/src/test-setup.ts` — the code
 * is identical, only the docblock's audience changed: this package has no
 * plain-`bun` half, so unlike the client app there is no second test cwd to
 * keep DOM out of.
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
