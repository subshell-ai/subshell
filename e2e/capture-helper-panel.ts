import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

/**
 * The macOS display helper's consent panel, photographed as it ships.
 *
 * The page is the same single-file build the helper loads through
 * `loadFileURL`, opened here in Chromium. The frame is wider than the panel's
 * own window because the page sets its own 520px card and the crop is that
 * card, so the extra room changes nothing the person would see.
 * The only thing the script does is what Swift does: hand the page a state
 * through `window.subshellSetState`. No control is drawn by this file, nothing
 * is clicked into a pose, and no button is faked, which is what makes the image
 * safe to publish as the thing a person will actually see and press.
 *
 * Two frames, because the page has two jobs: ask for consent once, then tell
 * the truth about a running helper (including the permission macOS has not
 * granted yet, which is the state most people arrive in).
 *
 * Run from the repository root after building the panel:
 *   bun run --cwd packages/helper-panel build
 *   bun e2e/capture-helper-panel.ts
 */
const dist = path.resolve(import.meta.dirname, "../packages/helper-panel/dist/index.html");
if (!existsSync(dist)) {
  throw new Error("Build the panel first: bun run --cwd packages/helper-panel build");
}
const out = path.resolve(import.meta.dirname, "../apps/docs/public/screenshots");

/** The state a Mac reports before anyone has agreed to anything. */
const BEFORE_CONSENT = {
  enabled: false,
  screenRecording: false,
  accessibility: false,
  viewers: 0,
  error: "",
  loginItem: "notRegistered",
} as const;

/** Capture running, one permission still missing, two people watching. */
const RUNNING = {
  enabled: true,
  screenRecording: true,
  accessibility: false,
  viewers: 2,
  error: "",
  loginItem: "registered",
} as const;

/** The hook the helper installs before it pushes state. Declared here rather
 *  than imported from the panel package, so this file stays a plain browser
 *  driver that happens to speak the same two words as Swift. */
declare global {
  interface Window {
    subshellSetState?: (state: Record<string, unknown>) => void;
  }
}

const dimensions: Record<string, { width: number; height: number }> = {};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 560, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file://${dist}`);
  // The page installs its own state hook; wait for it rather than racing the
  // module, the same order Swift guarantees by pushing only after the load.
  await page.waitForFunction(() => typeof window.subshellSetState === "function");

  for (const [name, state] of [
    ["display-helper-enable", BEFORE_CONSENT],
    ["display-helper-panel", RUNNING],
  ] as const) {
    await page.evaluate((next) => window.subshellSetState?.(next), { ...state });
    await page.waitForTimeout(120);
    dimensions[name] = await captureScreenshot(page, path.join(out, `${name}.png`), page.locator("section.card"));
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(dimensions, null, 2));
