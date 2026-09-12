/**
 * How this agent process runs, for the `ready` frame (spec 2026-09-12 § 6.1).
 *
 * Facts about a PROCESS rather than about the node: the control plane keeps
 * the report on the live connection and drops it when the socket goes, so
 * nothing here is ever read back stale from a table.
 */
import type { NodeRuntimeReport } from "@internal/subshell-protocol";
import { configPath } from "./config.js";
import { selfInvokePrefix } from "./self-invoke.js";
import { AGENT_LOG_HINT, DEFAULT_DEPS, queryService, type ServiceState } from "./service.js";

/** Injectable seams; production passes nothing. */
export interface RuntimeDeps {
  /** The platform whose service manager is named (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** This process's pid, compared against the manager's (default `process.pid`). */
  pid?: number;
  /** The service-status read (default a real `queryService` spawn). */
  queryService?: () => Promise<ServiceState>;
  /** PATH lookup for the tmux probe (default `Bun.which`). */
  which?: (name: string) => string | null;
  /** The agent config file (default `configPath()`). */
  configPath?: string;
  /** The binary this process re-enters (default `selfInvokePrefix().command`). */
  binaryPath?: string;
  /** Epoch-ms clock (default `Date.now`). */
  now?: () => number;
  /** This process's uptime in seconds (default `process.uptime`). */
  uptimeSeconds?: () => number;
}

/**
 * Build the `ready.runtime` report: one `service status` read, computed once
 * at daemon start so the `ready` frame itself stays synchronous.
 *
 * `supervised` is the fact `restart` turns on: exiting is a restart only when
 * the manager started THIS pid. Anything else — a foreground `subshell run`,
 * a second daemon — would simply stop.
 *
 * @param deps - test seams; production omits them entirely
 * @returns the report to attach to `ready`
 */
export async function collectRuntime(deps: RuntimeDeps = {}): Promise<NodeRuntimeReport> {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const service = await (deps.queryService ?? (() => queryService(DEFAULT_DEPS(async () => true))))();
  const which = deps.which ?? ((name: string) => Bun.which(name) ?? null);
  const now = (deps.now ?? Date.now)();
  const uptime = (deps.uptimeSeconds ?? ((): number => process.uptime()))();
  const manager = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
  const logPath = service.logPath ?? null;
  return {
    startedAt: new Date(now - uptime * 1000).toISOString(),
    supervised: service.state === "running" && service.pid === pid,
    service: {
      manager,
      installed: service.installed,
      definitionPath: service.definitionPath,
      state: service.state,
      pid: service.pid,
      enabled: service.enabled,
      paneSafety: service.paneSafety ?? "unknown",
    },
    configPath: deps.configPath ?? configPath(),
    logPath,
    // The journal sentence stands in for the file systemd does not write.
    logHint: logPath === null && manager === "systemd" ? AGENT_LOG_HINT : null,
    tmuxPath: which("tmux"),
    binaryPath: deps.binaryPath ?? selfInvokePrefix().command,
  };
}
