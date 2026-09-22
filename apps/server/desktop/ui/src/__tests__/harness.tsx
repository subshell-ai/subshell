/**
 * A fake IPC boundary for this page's component tests.
 *
 * Ported from `apps/client/desktop/ui/src/__tests__/harness.tsx` and stubbed
 * at the same seam — `window.__TAURI_INTERNALS__.invoke` — for the same
 * reason: that global IS the boundary, `invoke()` is a one-line delegation to
 * it, and the real client code runs instead of being mocked away. The
 * commands here are THIS app's `desktop_*` set.
 *
 * Not a test file (no `.test.` in the name), so `bun test` does not collect it.
 */
import type { About, Probe } from "../lib/ipc";

/** One recorded IPC call. */
export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

/** A machine that has been set up and whose server is running. */
export function makeProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "0.12.1",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "ready",
    error: null,
    tmux: "/opt/homebrew/bin/tmux",
    platform: "darwin",
    hasBrew: true,
    onboarded: true,
    hostname: "testhost",
    supervision: "service",
    supervisor: null,
    notificationPermission: "authorized",
    photosPermission: "authorized",
    pendingInstall: null,
    ...overrides,
  };
}

/** The about block the boot sequence reads once. */
export function makeAbout(overrides: Partial<About> = {}): About {
  return {
    productName: "subshell-server",
    appName: "Subshell Server",
    appVersion: "0.12.1",
    copyright: "Copyright 2026 Disaresta, LLC",
    company: "Disaresta, LLC",
    licenseSummary: "AGPL-3.0-only",
    websiteUrl: "https://subshell.sh",
    licenseUrl: "https://subshell.sh/license",
    companyUrl: "https://disaresta.com",
    ...overrides,
  };
}

export interface FakeIpc {
  /** Every call, in order. */
  calls: IpcCall[];
  /** Calls for one command, in order. */
  callsTo: (cmd: string) => Record<string, unknown>[];
  /** Replace what the next `desktop_probe` answers. */
  setProbe: (probe: Probe) => void;
  restore: () => void;
}

/**
 * Install the fake. `handlers` overrides one command; anything not handled
 * and not `desktop_probe`/`desktop_about` rejects loudly, so a command the
 * test did not think about cannot silently pass.
 */
export function installFakeIpc(
  init: { probe?: Probe; about?: About; handlers?: Record<string, Handler> } = {},
): FakeIpc {
  let probe = init.probe ?? makeProbe();
  const about = init.about ?? makeAbout();
  const handlers = init.handlers ?? {};
  const calls: IpcCall[] = [];
  const host = window as unknown as Record<string, unknown>;
  const previous = host.__TAURI_INTERNALS__;

  host.__TAURI_INTERNALS__ = {
    // `listen()` registers its callback through this before it invokes
    // anything, so a fake without it throws inside the page's own effect
    // rather than failing a test's assertion. The id is unused: nothing here
    // ever delivers an event.
    transformCallback: (callback: unknown) => {
      void callback;
      return 1;
    },
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      const handler = handlers[cmd];
      if (handler) return handler(args);
      if (cmd === "desktop_probe") return probe;
      if (cmd === "desktop_about") return about;
      // Tauri's own event plugin, which the page subscribes to for the
      // screen requests, the install line, the reset meter and the download
      // progress. Answered here rather than in every test's handler map: it
      // is plumbing the page always does, not a command any case is about.
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "plugin:event|unlisten") return null;
      throw new Error(`unstubbed command: ${cmd}`);
    },
  };

  return {
    calls,
    callsTo: (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    setProbe: (next) => {
      probe = next;
    },
    restore: () => {
      host.__TAURI_INTERNALS__ = previous;
    },
  };
}

/** A promise plus its resolver, for holding a command in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
