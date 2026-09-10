import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Query key of the instance plugin catalog (`GET /api/plugins`). */
export const INSTANCE_PLUGINS_QUERY_KEY = ["instance-plugins"] as const;

/** One plugin as the instance page renders it — mirrors the server's PluginRowSchema. */
export interface InstancePluginRow {
  /** Plugin id (its directory name under the instance's plugins dir) */
  id: string;
  /** Display name, from the installed plugin or this build's manifest */
  name: string;
  /** One-line description */
  description: string;
  /** Icon label */
  icon?: string;
  /** Driven program's command name, from the plugin this process resolves */
  binary?: string;
  /** Installed package version (absent when not installed) */
  version?: string;
  /** Whether the instance store holds this plugin */
  installed: boolean;
  /** Offered or merely held (spec §6.1); an install the flag table never touched reads enabled */
  enabled: boolean;
  /** True when THIS build ships the plugin (one-click install from the catalog) */
  builtIn: boolean;
  /** Why the plugin will not load in the control-plane process; present means every launch of it fails */
  broken?: string;
}

/** What an uninstall would touch — mirrors the server's ImpactResponseSchema. */
export interface PluginImpact {
  /** Profiles using this harness, across every user */
  profiles: number;
  /** Every user who owns one of those profiles, the caller included — the "across N users" count */
  distinctUsers: number;
  /** How many are auto-seeded Defaults (`mode=delete` removes these too) */
  defaults: number;
  /** RUNNING subshells on this harness; uninstalling touches none of them */
  runningSubshells: number;
}

/** What an uninstall does to profiles (spec §6.1); keep is the server's default too. */
export type UninstallMode = "keep" | "delete";

/**
 * The instance catalog: the embedded built-ins merged with the installed
 * store (spec 2026-09-10 §6). NOT admin-gated — the GET is open to every
 * authenticated actor, because "what is installed and offered" is not a
 * management secret; only the writes are, and the page hides their controls.
 */
export function useInstancePlugins() {
  return useQuery({
    queryKey: INSTANCE_PLUGINS_QUERY_KEY,
    queryFn: () => apiFetch<{ plugins: InstancePluginRow[] }>("/api/plugins"),
  });
}

/**
 * Installs a plugin into the instance store (cookie admin).
 * A `spec` fetches that npm package and its code then runs IN the server
 * process; absent, this build's embedded copy.
 */
export function useInstallInstancePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { pluginId: string; spec?: string }) =>
      apiFetch<InstancePluginRow>("/api/plugins", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
    },
  });
}

/**
 * Offers a plugin (true) or holds its bytes without offering them (false).
 * Profiles are never touched in either direction — disabling is the
 * operation uninstall cannot express, which is why it exists.
 */
export function useSetPluginEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<InstancePluginRow>(`/api/plugins/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
    },
  });
}

/**
 * The blast radius an uninstall would have. Read lazily and freshly: the
 * uninstall dialog passes an id only while it is open, so every open asks
 * again rather than rendering a count from a previous visit.
 */
export function usePluginImpact(pluginId: string | null) {
  return useQuery({
    queryKey: [...INSTANCE_PLUGINS_QUERY_KEY, "impact", pluginId] as const,
    queryFn: () => apiFetch<PluginImpact>(`/api/plugins/${pluginId}/impact`),
    enabled: pluginId !== null,
  });
}

/**
 * Uninstalls from the instance store (cookie admin). `keep` never touches
 * profiles; `delete` sweeps them across every user, Defaults included
 * (spec §6.1). Running subshells are unaffected either way.
 */
export function useUninstallInstancePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: UninstallMode }) =>
      apiFetch<{ ok: boolean; mode: UninstallMode; profilesRemoved: number }>(`/api/plugins/${id}?mode=${mode}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
    },
  });
}
