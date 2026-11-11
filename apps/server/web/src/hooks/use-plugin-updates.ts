import { apiFetch, errMessage } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { INSTANCE_PLUGINS_QUERY_KEY, type InstancePluginRow } from "@/hooks/use-instance-plugins";
import { NETWORK_QUERY_KEY } from "@/hooks/use-network";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";

/** Query key of the plugin update check (`GET /api/plugins/updates`). */
export const PLUGIN_UPDATES_QUERY_KEY = ["plugin-updates"] as const;

/** One offer: an installed plugin whose registry `latest` is newer than the effective version. */
export interface PluginUpdateRow {
  /** Plugin id (its directory name under the instance's plugins dir) */
  id: string;
  /** Package name to show the person */
  name: string;
  /** The effective version the check compared against */
  from: string;
  /** The version `latest` names; always concrete, because the server filters nulls out */
  to: string;
}

/** One plugin the registry could not be read for, so its offer is unknown rather than absent. */
export interface PluginCheckError {
  /** Plugin id */
  id: string;
  /** Package name, so the card can name what was not checked */
  name: string;
  /** Why the registry read failed */
  message: string;
}

/** What a check answers — mirrors the server's update route shape. */
export interface PluginUpdatesView {
  /** Plugins with a strictly newer `latest` */
  updates: PluginUpdateRow[];
  /** Plugins whose registry read failed; an entry here means "not checked", not "up to date" */
  errors: PluginCheckError[];
  /** Epoch milliseconds of the server's check, matching the release index */
  checkedAt: number;
}

/**
 * The plugin update check (`GET /api/plugins/updates`), admin-only. The server
 * memoizes it for 15 minutes and points at the instance's configured registry
 * (`SUBSHELL_PLUGIN_REGISTRY_URL`), not a hardcoded npm.
 *
 * `enabled` is the CONFIRMED admin flag rather than a default of true, the
 * same gate `/settings/status` and `/api/network` established: a member's
 * mount must fire no doomed 403, and non-admins keep the readable list they
 * have today.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 */
export function usePluginUpdates(enabled: boolean) {
  return useQuery({
    queryKey: PLUGIN_UPDATES_QUERY_KEY,
    queryFn: () => apiFetch<PluginUpdatesView>("/api/plugins/updates"),
    enabled,
  });
}

/** What {@link useCheckPluginUpdates} hands the card's Check button. */
export interface CheckPluginUpdates {
  /** Ask the registry now, bypassing the server's 15-minute memo. */
  check(): void;
  /** True while the check is in flight. */
  pending: boolean;
  /** Why the last check failed, null when it did not. */
  error: string | null;
}

/**
 * `POST /api/plugins/updates/check` — the "Check for updates" button.
 *
 * Unlike the server update check, this answers the WHOLE view, so the fresh
 * offers go straight into the query cache: the card renders the server's
 * answer before (or without) a refetch. The invalidation afterwards marks the
 * reader stale, so a mounted query reconciles through its ordinary path and
 * the check is visible to every consumer of the view, not only the one that
 * pressed the button.
 */
export function useCheckPluginUpdates(): CheckPluginUpdates {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => apiFetch<PluginUpdatesView>("/api/plugins/updates/check", { method: "POST" }),
    onSuccess: (view) => {
      queryClient.setQueryData(PLUGIN_UPDATES_QUERY_KEY, view);
      void queryClient.invalidateQueries({ queryKey: PLUGIN_UPDATES_QUERY_KEY });
    },
  });
  return {
    check: () => mutation.mutate(),
    pending: mutation.isPending,
    error: mutation.error ? errMessage(mutation.error, "Could not check for plugin updates.") : null,
  };
}

/**
 * Installs the registry's `latest` for one plugin (`POST
 * /api/plugins/:pluginId/update`, cookie admin). Mirrors the install act: the
 * server re-resolves `latest` at act time, refuses a non-newer answer, and
 * answers the updated row. No restart happens here — the page offers it while
 * a row reports `restartRequired`.
 *
 * Every surface an install refreshes is refreshed here too: the bytes in the
 * store can change a plugin's manifest, so the catalog row, this offer list,
 * the presets whose availability is the store (spec 2026-09-13 amendment) and
 * a network plugin's addresses on the live allowlist (spec 2026-09-16) all
 * move with the update.
 */
export function useUpdatePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<InstancePluginRow>(`/api/plugins/${id}/update`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PLUGIN_UPDATES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    },
  });
}
