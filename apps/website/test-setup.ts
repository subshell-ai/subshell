/**
 * Bun test preload: happy-dom globals for real component trees, and the
 * React `act()` signal. The minimal shape of apps/server/web's setup — the
 * website has no canvas, no matchMedia consumer and no import-time fetch
 * binder, so nothing beyond the registrar and the URL park is loaded here.
 *
 * The URL park matters for the same reason server-web documented: happy-dom
 * follows an un-prevented click on an `<a href>`, and the install column is
 * full of download anchors. A test that clicks one and asserts something
 * afterwards must not leave every later file reading a moved window.location.
 */
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const WINDOW_URL = "http://localhost/";
GlobalRegistrator.register({ url: WINDOW_URL });

afterEach(() => {
  const happy = (window as unknown as { happyDOM?: { setURL?: (url: string) => void } }).happyDOM;
  happy?.setURL?.(WINDOW_URL);
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
