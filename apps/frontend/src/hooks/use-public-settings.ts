import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Query key of the instance's public settings (`GET /api/settings/public`). */
export const PUBLIC_SETTINGS_QUERY_KEY = ["settings-public"] as const;

/** Shape of `GET /api/settings/public` — the server's instance-level reads. */
export interface PublicSettings {
  /** Whether new users can register (the login page hides the sign-up link when false) */
  allowRegistrations: boolean;
  /** True while MOTE_EMERGENCY_PASSWORD is set (spec 2026-08-31 §6) */
  emergencyLoginActive: boolean;
  /**
   * The server's own base URL (APP_BASE_URL) — what it bakes into rendered
   * install commands (spec 2026-08-31 Phase 3). May point at loopback, which
   * the Nodes dialog warns about; a remote node must dial a reachable address.
   */
  appBaseUrl: string;
}

/**
 * The single fetcher for `GET /api/settings/public`, shared by the emergency
 * banner and the Add-node dialog (was an inline `useQuery` in the banner —
 * a second copy here would fork the cache).
 *
 * staleTime 30 s mirrors the current-user freshness: after the operator
 * changes env and restarts, consumers settle on the next mount within the
 * window without a manual reload, and the endpoint is local + cheap.
 */
export function usePublicSettings() {
  return useQuery({
    queryKey: PUBLIC_SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<PublicSettings>("/api/settings/public"),
    staleTime: 30_000,
  });
}
