/**
 * A fake IPC boundary for the component tests.
 *
 * Stubbed at `window.__TAURI_INTERNALS__.invoke` rather than by mocking the
 * `@tauri-apps/api` module: that global IS the boundary — `invoke()` is a
 * one-line delegation to it, and `@tauri-apps/plugin-dialog`'s `open()` goes
 * through the same `invoke` as `plugin:dialog|open`. So the real client code
 * runs, the file picker is stubbable by the same mechanism, and a change to how
 * `lib/ipc.ts` reaches Tauri is caught here instead of being mocked away.
 *
 * Not a test file (no `.test.` in the name), so `bun test` does not collect it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { NodeSettings, Probe } from "@/lib/ipc";

/** One recorded IPC call. */
export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

/** A probe of an online, healthy, service-managed node. */
export function makeProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "1.9.0",
    agent: { argv: ["/home/u/.local/bin/subshell"], source: "local-bin", version: "1.9.0" },
    managed: true,
    status: {
      nodeId: "11111111-2222-3333-4444-555555555555",
      serverUrl: "https://subshell.example.com",
      online: true,
      agentVersion: "1.9.0",
      daemonAgeMs: 4_000,
    },
    service: {
      installed: true,
      definitionPath: "/home/u/.config/systemd/user/subshell.service",
      state: "running",
      pid: 42,
      enabled: true,
      paneSafety: "keeps",
      detail: "",
    },
    agentChoice: "up-to-date",
    step: "online",
    error: null,
    tmux: "/usr/bin/tmux",
    paths: {
      configDir: "/home/u/.config/subshell",
      configFile: "/home/u/.config/subshell/config.json",
      dataDir: "/home/u/.config/subshell/data",
      agentLog: null,
      agentLogHint: "the agent logs to the systemd journal on Linux — run `journalctl --user -u subshell.service -f`",
    },
    rewriteTearsDown: false,
    ...overrides,
  };
}

/**
 * Default settings for a machine with no tray at all.
 *
 * `trayStatus` follows `traySupported` unless a test says otherwise, mirroring
 * the Rust side, where both fields come from one probe answer and cannot
 * disagree. Pass `trayStatus: "not-detected"` for the Linux-without-a-host
 * case, which is the one where the switch is drawn but not live.
 */
export function makeSettings(overrides: Partial<NodeSettings> = {}): NodeSettings {
  const traySupported = overrides.traySupported ?? false;
  return {
    agentBinPath: null,
    closeToTray: false,
    traySupported,
    trayStatus: traySupported ? "supported" : "unsupported",
    ...overrides,
  };
}

export interface FakeIpc {
  /** Every call, in order. */
  calls: IpcCall[];
  /** Calls for one command, in order. */
  callsTo: (cmd: string) => Record<string, unknown>[];
  /** Replace what the next `node_probe` answers. */
  setProbe: (probe: Probe) => void;
  restore: () => void;
}

/**
 * Install the fake. `handlers` overrides one command; anything not handled and
 * not `node_probe`/`node_settings` rejects loudly, so a command the test did
 * not think about cannot silently pass.
 */
export function installFakeIpc(
  init: { probe?: Probe; settings?: NodeSettings; handlers?: Record<string, Handler> } = {},
): FakeIpc {
  let probe = init.probe ?? makeProbe();
  const settings = init.settings ?? makeSettings();
  const handlers = init.handlers ?? {};
  const calls: IpcCall[] = [];
  const host = window as unknown as Record<string, unknown>;
  const previous = host.__TAURI_INTERNALS__;

  host.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      const handler = handlers[cmd];
      if (handler) return handler(args);
      if (cmd === "node_probe") return probe;
      if (cmd === "node_settings") return settings;
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

/** Render a tree under a fresh query client with retries off. */
export function renderApp(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

/** A promise plus its resolver, for holding a command in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
