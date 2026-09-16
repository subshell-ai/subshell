import type { ServerAutostart } from "@/hooks/use-server-deployment";
import type { SetSupervision } from "@/hooks/use-set-supervision";
import type { SupervisionMode } from "@/lib/supervision";
import type { ServerDeployment, ServerSetting, SettingSource } from "@/types/server-deployment";

/**
 * A complete `GET /api/admin/server` body, for the Service page's cards.
 *
 * Shared by every card test rather than re-typed in each: the view is large
 * and mostly irrelevant to any one card, so a per-file copy would be five
 * copies drifting away from the route's schema at five different rates.
 */

/** One setting whose saved and running values agree — the ordinary case. */
export function setting(saved: string, source: SettingSource = "config.env"): ServerSetting {
  return { saved, source, running: saved };
}

/**
 * The deployment view, with any settings overridden.
 * @param over - settings entries to replace
 */
export function deploymentView(
  over: Partial<ServerDeployment["settings"]> = {},
  /**
   * View-level overrides (`restartRequired`, `restart`, …). The settings map
   * is the common override; the network card's staleness gate reads
   * `restartRequired`, which is not a setting.
   */
  viewOver: Partial<ServerDeployment> = {},
): ServerDeployment {
  return {
    configEnv: { path: "/c/config.env", exists: true },
    settings: {
      SERVER_PORT: setting("3080"),
      HOST: setting("0.0.0.0"),
      APP_BASE_URL: setting("http://localhost:3080"),
      DATABASE_PATH: setting("/c/subshell.db"),
      TRUSTED_ORIGINS: setting(""),
      ...over,
    },
    restartRequired: false,
    ...viewOver,
    authSecret: { state: "set", source: "config.env" },
    paths: {
      dataDir: "/c",
      database: "/c/subshell.db",
      logsDir: "/c/subshells",
      nodeArtifacts: "/c/node-artifacts",
      serverLog: "/c/logs/server.log",
    },
    service: {
      manager: "launchd",
      installed: true,
      definitionPath: "/p",
      state: "running",
      pid: 1,
      enabled: true,
      linger: null,
      paneSafety: "keeps",
      logPath: "/l",
      logHint: null,
      supervised: true,
    },
    restart: { available: true, reason: null },
    logging: { debug: false, source: "default", file: "/c/logs/server.log", capBytes: 204_800 },
    tmuxPath: "/t",
    mcp: null,
    mcpError: null,
    platform: "darwin",
    generatedAt: "2026-09-12T10:00:00.000Z",
  };
}

/**
 * The same view as an ordinary headless LINUX host — the deployment the base
 * fixture (darwin, launchd) is least like, and the one whose persistence
 * answer depends on a fact macOS does not have: whether the OS user lingers.
 *
 * @param over - service fields to replace, `linger` above all
 */
export function linuxDeploymentView(over: Partial<ServerDeployment["service"]> = {}): ServerDeployment {
  const view = deploymentView();
  view.platform = "linux";
  view.service = {
    ...view.service,
    manager: "systemd",
    // systemd writes to the journal, so there is no file to name — the same
    // shape the route reports on Linux.
    logPath: null,
    logHint: "journalctl --user -u subshell-server",
    linger: false,
    ...over,
  };
  return view;
}

/** A restart handle that is idle and does nothing — for cards that only render it. */
export const idleRestart = {
  outcome: "idle" as const,
  error: null,
  restart: async () => {},
};

/** A start-at-login handle that records presses and never resolves anything. */
export function stubAutostart(over: Partial<ServerAutostart> = {}): ServerAutostart & { pressed: boolean[] } {
  const pressed: boolean[] = [];
  return {
    pressed,
    set: (enabled: boolean) => pressed.push(enabled),
    pending: false,
    error: null,
    ...over,
  };
}

/** A mode-switch handle that records calls and answers as told. */
export function stubSupervision(
  over: {
    result?: boolean;
    error?: string | null;
    details?: string | null;
    pending?: boolean;
    settling?: SupervisionMode | null;
    timedOut?: boolean;
  } = {},
): SetSupervision & { calls: { mode: string; autostart: boolean; force: boolean }[]; resets: number } {
  const calls: { mode: string; autostart: boolean; force: boolean }[] = [];
  const handle = {
    calls,
    resets: 0,
    settling: over.settling ?? null,
    timedOut: over.timedOut ?? false,
    set: async (mode: SupervisionMode, autostart: boolean, force: boolean) => {
      calls.push({ mode, autostart, force });
      return over.result ?? true;
    },
    pending: over.pending ?? false,
    error: over.error ?? null,
    details: over.details ?? null,
    reset: () => {
      handle.resets += 1;
    },
  };
  return handle;
}
