import { apiFetch } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NETWORK_QUERY_KEY } from "@/hooks/use-network";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";

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
  /**
   * Manifest plugin type: an agent CLI, a plain shell, or a NETWORK — a
   * plugin that connects this control plane to a private network and drives
   * no pane at all.
   *
   * The launch surfaces branch on this, and `network` is why they now test
   * for `agent-harness` rather than for "not terminal": a network plugin is
   * not a slower agent, it is not an agent, and a rule written as an
   * exclusion silently admitted every type invented after it.
   *
   * Optional for an older server's payload; absent reads as agent.
   */
  type?: "agent-harness" | "terminal" | "network";
}

/** What an uninstall would touch — mirrors the server's ImpactResponseSchema. */
export interface PluginImpact {
  /** Presets using this harness, across every user */
  presets: number;
  /** Every user who owns one of those presets, the caller included — the "across N users" count */
  distinctUsers: number;
  /** RUNNING subshells on this harness; uninstalling touches none of them */
  runningSubshells: number;
}

/** What an uninstall does to presets (spec §6.1); keep is the server's default too. */
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
      // Availability is the STORE now (spec 2026-09-13 amendment): the list
      // route filters on installed ∧ enabled ∧ ¬broken, so an install makes
      // presets for this plugin appear. Same reason the uninstall below
      // refreshes them.
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}

/**
 * Offers a plugin (true) or holds its bytes without offering them (false).
 * No preset ROW is touched in either direction — disabling is the operation
 * uninstall cannot express, which is why it exists — but which presets are
 * LISTED does change: availability is the store (spec 2026-09-13 amendment),
 * so disabling hides this plugin's presets exactly as an uninstall does and
 * enabling brings them back. Rows and visibility are different questions;
 * only the first is what "never touched" was ever about.
 *
 * A network plugin's toggle also changes what the server offers and trusts;
 * the Networking card's Disable/Enable action is this same mutation.
 */
export function useSetPluginEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<InstancePluginRow>(`/api/plugins/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
      // See the docblock: the toggle changes what the preset list ANSWERS,
      // so a mounted /presets page or an open launch dialog is stale the
      // moment this returns.
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
      // A NETWORK plugin's flag decides whether its addresses are offered and
      // trusted at all: the server's allowlist is local origins ∪ config.env
      // extras ∪ every ENABLED network plugin's addresses (2026-09-16), and
      // disabling runs the unpublish sequence first (`plugins.route.ts`). So
      // the row's state on the Networking page and the effective allowlist
      // the mobile dialog and the setup checklist read both moved. Refreshed
      // for every plugin type rather than branched on `type`: the two GETs are
      // cheap, and a rule keyed on the row's type would be one more place for
      // "network" to be spelled.
      void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
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
 * presets; `delete` sweeps them across every user (spec §6.1). Running
 * subshells are unaffected either way.
 */
export function useUninstallInstancePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: UninstallMode }) =>
      apiFetch<{ ok: boolean; mode: UninstallMode; presetsRemoved: number }>(`/api/plugins/${id}?mode=${mode}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
      // `mode=delete` swept presets across EVERY user (spec §6.1), so the
      // preset list a viewer has open is stale the moment this returns;
      // `keep` touched none and the extra refetch is the cheap, honest
      // default for both modes rather than branching on the flag's meaning.
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
