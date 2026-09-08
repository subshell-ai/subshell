import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./ports";

/**
 * End-to-end tests: a real browser against the real backend serving the built
 * SPA, a real temp-file SQLite DB, and real tmux sessions (stub `pi` harness).
 * globalSetup owns the stack — Playwright's own webServer starts before
 * globalSetup and would race the build. Not part of `turbo test`.
 *
 * `workers: 1` on purpose: specs share one database and run in file order —
 * 01 creates the admin every later spec logs in as.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // CI runs inside a container AS ROOT (the self-hosted fleet's builder
    // image), and Chromium refuses to start as root with its sandbox on:
    // "Running as root without --no-sandbox is not supported". Scoped to CI
    // on purpose — a developer's run keeps the sandbox, which is the whole
    // reason not to just set this unconditionally.
    launchOptions: { args: process.env.CI ? ["--no-sandbox"] : [] },
  },
  projects: [
    // Desktop specs run everywhere EXCEPT the mobile projects, which only
    // pick up the 08/09 mobile suite (specs 00-07 assume desktop chrome).
    // The mobile projects borrow the device descriptors (viewport, UA,
    // isMobile/hasTouch → coarse pointer) but pin browserName to chromium:
    // the device presets default to webkit, which is not installed here —
    // the whole suite runs one browser. Real-device Safari remains the manual
    // gate from the design spec (§9).
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: [/0\d-mobile/] },
    {
      name: "mobile",
      use: { ...devices["iPhone 15 Pro"], browserName: "chromium" },
      testMatch: [/0\d-mobile/],
    },
    {
      name: "ipad-landscape",
      use: { ...devices["iPad Pro 11 landscape"], browserName: "chromium" },
      testMatch: [/08-mobile/],
    },
  ],
});
