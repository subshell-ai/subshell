import type { ServerAutostart } from "@/hooks/use-server-deployment";
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
export function deploymentView(over: Partial<ServerDeployment["settings"]> = {}): ServerDeployment {
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

/** A restart handle that is idle and does nothing — for cards that only render it. */
export const idleRestart = {
  outcome: "idle" as const,
  error: null,
  resumeAt: null,
  restart: async () => {},
  reset: () => {},
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
