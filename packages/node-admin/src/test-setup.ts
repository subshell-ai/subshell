/**
 * Bun test preload: registers happy-dom globals so the card tests can render
 * real React trees. The pared-down sibling of the server SPA's own preload —
 * it carries only what the moved suites need. The SPA's `setFetchRouter`
 * delegator is NOT copied here because every suite in this package swaps
 * `globalThis.fetch` inside the test, and nothing here binds fetch at import.
 */
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const WINDOW_URL = "http://localhost/";
GlobalRegistrator.register({ url: WINDOW_URL });

/** Park the shared window's location back after EVERY test (see the SPA's preload for why). */
afterEach(() => {
  const happy = (window as unknown as { happyDOM?: { setURL?: (url: string) => void } }).happyDOM;
  happy?.setURL?.(WINDOW_URL);
});

const globals = globalThis as Record<string, unknown>;
// React 19's act() machinery wants this set before any render.
globals.IS_REACT_ACT_ENVIRONMENT = true;
