/**
 * Which catalog rows the New screen may show at all.
 *
 * Hand-mirror of the web's `buildAgentOptions` exclusion (the repo
 * convention for this screen; change one, change both): networks drive no
 * pane so they were never launch options, and a plugin that declares
 * `pickable: false` says the same thing about itself. This drops rows;
 * greying lives elsewhere.
 */
import type { PluginView } from "@/types/plugin";

/** True when one plugin row belongs in the Agent chips and the default rule. */
export function isLaunchVisible(plugin: PluginView): boolean {
  return plugin.type !== "network" && plugin.pickable !== false;
}
