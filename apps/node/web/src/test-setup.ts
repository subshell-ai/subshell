/**
 * Bun test preload: registers happy-dom globals so the component tests can
 * render real React trees. The same pared-down registration the
 * `@internal/node-admin` package uses; the dashboard owns no fetch router and
 * binds nothing at import, so this is the whole setup.
 */
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const WINDOW_URL = "http://localhost/";
GlobalRegistrator.register({ url: WINDOW_URL });

/** Park the shared window's location back after EVERY test. */
afterEach(() => {
  const happy = (window as unknown as { happyDOM?: { setURL?: (url: string) => void } }).happyDOM;
  happy?.setURL?.(WINDOW_URL);
});

const globals = globalThis as Record<string, unknown>;
// React 19's act() machinery wants this set before any render.
globals.IS_REACT_ACT_ENVIRONMENT = true;
