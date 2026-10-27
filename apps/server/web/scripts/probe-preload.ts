/**
 * Minimal happy-dom registration for the manual probe scripts.
 *
 * The suite preload (`src/test-setup.ts`) also installs a fetch delegator and
 * a `bun:test` afterEach, which make it unusable for a plain `bun <script>`
 * run ("Cannot use afterEach() outside of the test runner"). xterm needs only
 * the DOM globals, so the probes get their own one-job preload.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/", settings: { disableIframePageLoading: true } });
