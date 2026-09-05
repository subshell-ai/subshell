import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Query key of the instance status read (`GET /api/admin/status`). */
export const ADMIN_STATUS_QUERY_KEY = ["admin-status"] as const;

/** An enrolled agent this control plane would refuse at connect. */
export interface OutdatedAgent {
  /** Node id */
  id: string;
  /** Node display name */
  name: string;
  /** Last-known agent version, null if it never reported one */
  agentVersion: string | null;
}

/** Shape of `GET /api/admin/status` — mirrors the server's AdminStatusSchema. */
export interface AdminStatus {
  versions: {
    /** Server app version */
    server: string;
    /** Node protocol version this control plane speaks; agents must match exactly */
    nodeProtocol: number;
    /** Oldest agent version accepted on /ws/node */
    minAgent: string;
    /** Bun runtime version */
    bun: string;
  };
  runtime: {
    /** Whole seconds since the process started */
    uptimeSeconds: number;
    /** Process start time (ISO), derived from uptime */
    bootedAt: string;
    /** Process id on the control-plane host */
    pid: number;
    /** Host OS in the node vocabulary */
    os: string;
    /** Host CPU architecture */
    arch: string;
    /** Control-plane host name */
    hostname: string;
    /** True when NODE_ENV=production */
    production: boolean;
    /** Resident set size, bytes */
    memoryRssBytes: number;
    /** JS heap in use, bytes */
    memoryHeapUsedBytes: number;
    /** Configured bind address */
    listenHost: string;
    /** Configured port */
    listenPort: number;
    /** APP_BASE_URL the server bakes into install commands */
    appBaseUrl: string;
    /** Which SPA this process serves: disk | embedded | unselected */
    staticSource: string;
    /** Resolved SQLite path */
    databasePath: string;
    /** SQLite file size in bytes, null when it cannot be stat'd */
    databaseBytes: number | null;
    /** Resolved tmux binary, null when absent — local launches fail without it */
    tmuxPath: string | null;
    /** Resolved `subshell mcp` command, null when UNRESOLVED */
    mcpEntrypoint: string | null;
    /** Which rung resolved it: env | self | client-on-path */
    mcpSource: string | null;
  };
  inventory: {
    users: { total: number; admins: number };
    subshells: { total: number; running: number };
    nodes: { total: number; online: number; needingUpdate: OutdatedAgent[] };
    workspaces: number;
    channels: number;
    profiles: number;
  };
  security: {
    /** Whether new users can register */
    registrationsOpen: boolean;
    /** True while the break-glass hatch is armed */
    emergencyLoginActive: boolean;
    /** True when BETTER_AUTH_SECRET is still the built-in placeholder */
    usingPlaceholderSecret: boolean;
    systemKeys: { total: number; active: number };
  };
  /** When the server assembled the snapshot (ISO) */
  generatedAt: string;
}

/**
 * The instance status read, admin-only.
 *
 * `enabled` is the caller's admin flag, NOT a default of true: the endpoint
 * 403s a non-admin, and mounting the page while the flag is still unknown
 * would fire a doomed request on every visit (the same gate /settings applies
 * to its own admin queries).
 *
 * Refetches on an interval because uptime, memory and the online-node count
 * are live figures — a status page showing a frozen snapshot is worse than
 * one that admits it is polling.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 */
export function useAdminStatus(enabled: boolean) {
  return useQuery({
    queryKey: ADMIN_STATUS_QUERY_KEY,
    queryFn: () => apiFetch<AdminStatus>("/api/admin/status"),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
