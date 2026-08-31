import { ALL_HARNESSES, getHarness } from "@internal/harnesses";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";

/** All known harness plugin ids. */
export function getAllHarnessIds(): string[] {
  return ALL_HARNESSES.map((h) => h.id);
}

/**
 * Enabled state for every registered plugin, from the lazily-written
 * `harnessPlugins` rows (absent row => the plugin's own default).
 */
export async function harnessEnabledStates(): Promise<Map<string, boolean>> {
  const ids = getAllHarnessIds();
  const repo = new HarnessPluginsRepository(db);
  return await repo.getEnabledStates(ids);
}

/**
 * Usable = the plugin exists, is enabled, AND its binary is installed. The
 * install check is load-bearing here, matching the product rule "if it isn't
 * installed it stays unavailable": a missing binary hides the harness's
 * profiles and blocks new sessions even when the enabled flag defaults on.
 */
export async function harnessUsable(id: string): Promise<boolean> {
  const plugin = getHarness(id);
  if (!plugin) return false;
  const states = await harnessEnabledStates();
  if (!(states.get(id) ?? plugin.enabledByDefault)) return false;
  return await plugin.isInstalled();
}

/**
 * The subset of ids that are currently usable. Batched for the profile-list
 * filter (one install probe per harness).
 */
export async function usableHarnessIds(): Promise<Set<string>> {
  const states = await harnessEnabledStates();
  const usable = new Set<string>();
  for (const h of ALL_HARNESSES) {
    if ((states.get(h.id) ?? h.enabledByDefault) && (await h.isInstalled())) usable.add(h.id);
  }
  return usable;
}
