import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

/**
 * The assistants' **Virtual Displays** screen, photographed in the browser the
 * page is actually written for.
 *
 * The window is Tauri's, but everything inside it is this repo's React: the
 * shared `Frame` and `Rail` from `packages/assistant` and the screen's own
 * steps and button. Tauri's side is two reads (`node_settings`, `node_probe`)
 * and one press (`node_open_display_helper`, which this script never presses:
 * it opens a native window on someone else's machine). So the capture serves
 * the real UI at the real dev port, answers those reads with the facts a
 * configured Mac would report, and clicks the rail item like a person does.
 * The pixels are the shipped page, not a mockup; the window chrome is the
 * browser's, because the frame is identical and the docs photograph the page.
 *
 * Run from the repository root:
 *   bun e2e/capture-assistant-ui.ts
 *
 * It starts Vite itself and shuts it down; port 5177 must be free.
 */
const DEV_PORT = 5177;
const ORIGIN = `http://127.0.0.1:${DEV_PORT}`;
const APP = path.resolve(import.meta.dirname, "../apps/client/desktop");
const out = path.resolve(import.meta.dirname, "../apps/docs/public/screenshots");

/** The saved addresses, as `node_settings` reports them. Sample values only. */
const SETTINGS = { nodeBinPath: null, planes: ["http://172.16.2.50:3080"] };

/** A Mac whose node is enrolled, running, and online: what the rail gates on. */
const PROBE = {
  hasNodeConfig: true,
  bundledVersion: "1.6.0",
  nodeBinary: { argv: ["/Users/theo/.local/bin/subshell"], source: "local-bin", version: "1.6.0" },
  managed: true,
  status: {
    nodeId: "0f0c1a5b-7d0e-4a1e-9b3a-2f4c6d8e0a12",
    serverUrl: "http://172.16.2.50:3080",
    online: true,
    agentVersion: "1.6.0",
    daemonAgeMs: 412_000,
  },
  service: {
    installed: true,
    definitionPath: "/Users/theo/Library/LaunchAgents/nu.subshell.node.plist",
    state: "running",
    pid: 4212,
    enabled: true,
    autostart: true,
    paneSafety: null,
  },
  nodeChoice: "up-to-date",
  step: "online",
  error: null,
  tmux: "/opt/homebrew/bin/tmux",
  hasBrew: true,
  paths: {
    configDir: "/Users/theo/.config/subshell",
    configFile: "/Users/theo/.config/subshell/node.json",
    dataDir: "/Users/theo/.local/share/subshell",
    nodeLog: "/Users/theo/.local/state/subshell/daemon.log",
    nodeLogHint: null,
  },
  hostname: "MacBook-Pro",
  rewriteTearsDown: true,
  pendingInstall: null,
};

const dimensions: Record<string, { width: number; height: number }> = {};

// Its own process group, killed by negative pid on the way out: `bun run` is a
// wrapper, and signalling only the wrapper leaves Vite holding port 5177 for
// the next run (and for a developer's own `bun run dev:desktop-client`, whose
// devUrl is a fixed string and would then load this script's orphan server).
const vite = spawn("bun", ["run", "dev:ui"], { cwd: APP, stdio: "ignore", detached: true });
const unstubbed = new Set<string>();

try {
  // Wait for the port rather than sleeping: Vite's first bundle varies.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      // The rail's Virtual Displays section exists only where a display helper
      // exists, and that gate reads the user agent (`copy.ts`'s `isMacos`), so
      // the capture has to arrive as the Mac the screen is written for.
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SubshellClient/1.6.0 Chrome/130.0.0.0 Safari/537.36",
      viewport: { width: 1040, height: 760 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript(
      ([settings, probe]) => {
        const answers: Record<string, unknown> = {
          node_settings: settings,
          node_probe: probe,
          node_pending_screen: null,
          node_about: { appName: "Subshell Client", version: "1.6.0", commit: null, builtAt: null },
        };
        const callbacks = new Map<number, (payload: { error?: string; data?: unknown }) => void>();
        let nextCallback = 1;
        (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
          invoke: async (command: string) => {
            if (command in answers) return answers[command];
            // Anything else the page starts asking for is recorded rather than
            // silently nulled, so a new read shows up as a gap in this file
            // instead of a blank corner of a published screenshot.
            window.__unstubbedCommands = [...(window.__unstubbedCommands ?? []), command];
            return null;
          },
          transformCallback: (callback: (payload: unknown) => void, once = false) => {
            const id = nextCallback++;
            callbacks.set(id, (payload) => {
              callback(payload);
              if (once) callbacks.delete(id);
            });
            return id;
          },
          registerCallback: (callback: (payload: unknown) => void) => {
            const id = nextCallback++;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { windowLabel: "main", label: "main" },
          },
        };
      },
      [SETTINGS, PROBE] as [typeof SETTINGS, typeof PROBE],
    );

    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "load" });
    // The frame shows a checking state until the probe answers; wait past it.
    const railItem = page.getByRole("button", { name: "Virtual Displays" });
    await railItem.waitFor({ timeout: 20_000 });
    await railItem.click();
    await page.getByRole("heading", { name: "Virtual Displays" }).waitFor();
    await page.getByRole("button", { name: "Open Display Helper settings" }).waitFor();
    await page.waitForTimeout(250);

    dimensions["assistant-virtual-displays"] = await captureScreenshot(
      page,
      path.join(out, "assistant-virtual-displays.png"),
      page.locator("div.h-screen"),
    );

    const gaps = await page.evaluate(() => window.__unstubbedCommands ?? []);
    if (gaps.length > 0) {
      for (const command of new Set<string>(gaps)) unstubbed.add(command);
      console.warn(`Unstubbed Tauri commands (the page got null): ${[...unstubbed].join(", ")}`);
    }
  } finally {
    await browser.close();
  }
} finally {
  // The wrapper's process GROUP: `bun run` spawns Vite as a child, and
  // signalling the wrapper alone leaves the server holding port 5177.
  const group = vite.pid;
  try {
    if (group === undefined) vite.kill();
    else process.kill(-group, "SIGTERM");
  } catch {
    vite.kill(); // the group is already gone
  }
}

console.log(JSON.stringify(dimensions, null, 2));

declare global {
  interface Window {
    __unstubbedCommands?: string[];
  }
}
