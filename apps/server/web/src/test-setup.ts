/**
 * Bun test preload: registers happy-dom globals so component tests can
 * render real React trees, then fills the few browser APIs happy-dom lacks
 * that Radix primitives touch (popper measures with ResizeObserver, presence
 * checks matchMedia).
 */
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const WINDOW_URL = "http://localhost/";
GlobalRegistrator.register({ url: WINDOW_URL });

/**
 * Park the shared window's location back after EVERY test.
 *
 * The happy-dom window is process-global and its DOM has real default
 * actions: an un-prevented click on an `<a href>` runs happy-dom's page-open
 * navigation (HTMLAnchorElement.dispatchEvent → WindowPageOpenUtility.openPage
 * → BrowserFrameNavigator.navigate), which rewrites `window.location` for
 * every file that runs after it. `desktop-links.test.ts` must dispatch such
 * clicks un-prevented — "nothing prevented it, it is not ours" IS the
 * assertion — so its `.invalid` fixture hosts make the fetch instant, not the
 * navigation: the URL changes either way (measured 2026-09-17 — the file ends
 * with location at `https://app.example.invalid/`). AddNodeDialog's install
 * command falls back to `window.location.origin`, and that has been the
 * suite's flake: CI red on step 2, laptop green, purely by file ordering and
 * async timing. A location-dependent test must not inherit another test's
 * navigation history, so the URL is reset per test, exactly like the fetch
 * delegator above is installed globally for the same cross-file reason.
 */
afterEach(() => {
  const happy = (window as unknown as { happyDOM?: { setURL?: (url: string) => void } }).happyDOM;
  happy?.setURL?.(WINDOW_URL);
});

/**
 * A DELEGATING global fetch, installed before any test or app module loads.
 *
 * Why the preload and not the test file: better-auth's client binds `fetch`
 * at CREATION (module evaluation of `lib/auth-client`), and whichever test
 * file first imports a component touching it freezes whatever
 * `globalThis.fetch` is at that moment — a mock installed later by the
 * wizard's own file is invisible to it (measured: every registration hit the
 * real network and failed as "Network error", and which file "won" depended
 * on suite ordering). A delegator installed HERE is what every load-time
 * binder captures, and it reads the live handler per call.
 *
 * The established per-file pattern (swap `globalThis.fetch` inside a test)
 * still works unchanged — it simply outranks the delegator on the global.
 * A test needs this instead only when the code under test binds fetch at
 * import: it calls `setFetchRouter` for the duration and clears it after.
 */
type FetchRouter = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null;
let fetchRouter: FetchRouter = null;
const underlyingFetch = globalThis.fetch.bind(globalThis) as (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  (fetchRouter ?? underlyingFetch)(input, init)) as typeof globalThis.fetch;

/** Routes (or, with null, un-routes) the global fetch used by import-time binders. */
export function setFetchRouter(router: FetchRouter): void {
  fetchRouter = router;
}

const globals = globalThis as Record<string, unknown>;
// `__BUILD_ID__` is a Vite `define`: the real build inlines it at compile
// time, so under bun test the global simply is not there. It is typed as a
// bare const (src/vite-env.d.ts), so this supplies the VALUE the bundler would
// have, not a second declaration. Set HERE rather than per test file since
// 2026-09-14: the About dialog reads it, the sidebar mounts the dialog, and
// every test that renders the sidebar would otherwise throw a ReferenceError.
globals.__BUILD_ID__ = "2026-09-14 00:00";
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
