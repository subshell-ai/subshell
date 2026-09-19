import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Query key of the instance's public settings (`GET /api/settings/public`). */
export const PUBLIC_SETTINGS_QUERY_KEY = ["settings-public"] as const;

/** Shape of `GET /api/settings/public` — the server's instance-level reads. */
export interface PublicSettings {
  /** Whether new users can register (the login page hides the sign-up link when false) */
  allowRegistrations: boolean;
  /**
   * Whether a non-admin may add a node; an absent row on the server means true.
   *
   * OPTIONAL, like the other fields added after this payload existed: a
   * server older than the setting sends no such key, which is precisely the
   * case `lib/node-enrollment.ts` treats as allowed. Declaring it required
   * while the code is written around its absence makes the type say something
   * the code does not believe.
   */
  allowNodeEnrollment?: boolean;
  /** True while SUBSHELL_EMERGENCY_PASSWORD is set (spec 2026-08-31 §6) */
  emergencyLoginActive: boolean;
  /**
   * Operator-chosen name for this control plane, falling back server-side to
   * the host's own name — never blank (spec 2026-09-08). Rendered in the
   * sidebar so a person running several planes can tell them apart.
   */
  instanceName: string;
  /**
   * The server's own base URL (APP_BASE_URL) — what it bakes into rendered
   * install commands (spec 2026-08-31 Phase 3). May point at loopback, which
   * the Nodes dialog warns about; a remote node must dial a reachable address.
   */
  appBaseUrl: string;
  /**
   * Every origin a browser may sign in from (TRUSTED_ORIGINS) — this
   * instance's own addresses plus the configured extras, canonicalized
   * server-side.
   *
   * Read by the "Subshell for Mobile" dialog, which has to offer a PHONE an
   * address: `appBaseUrl` is one spelling and rarely the right one (a laptop
   * on loopback, a phone on the tailnet), and re-deriving the allowlist here
   * would be a second implementation of it.
   *
   * OPTIONAL, like every field added after this payload existed: a cached PWA
   * can outlive the server that served it, and the dialog falls back to the
   * address this browser is already on.
   */
  trustedOrigins?: string[];
  /**
   * True for admin COOKIE sessions (spec 2026-09-02 settings-split §5) —
   * gates the Server nav entry and the /settings page body. Bearer actors
   * always read false.
   */
  viewerIsAdmin: boolean;
  /**
   * Version of the SERVER app (its package.json). Per-app, not instance-wide:
   * the server, the node CLI and this bundle all version independently, so
   * this is never "the subshell version".
   */
  serverVersion: string;
  /**
   * Platform triples whose node binary the server ACTUALLY serves under
   * `/api/downloads/node/*`. Optional because a cached PWA can outlive its
   * server: undefined = a server predating the field → the Nodes dialog
   * stays silent rather than nagging about a field it cannot verify.
   */
  nodeArtifactTargets?: string[];
  /**
   * Whether the server downloads a MISSING node binary from the project's own
   * GitHub release the first time a machine asks for it.
   *
   * Optional, and defaulting to false at every use site, for the same reason
   * as the field above: a cached PWA can outlive its server, and an older
   * server that does not fetch must keep getting the warning it has always
   * had. Reading a missing field as `true` would silence the one message that
   * is still exactly right on an air-gapped instance.
   */
  nodeArtifactsAutoFetch?: boolean;
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
