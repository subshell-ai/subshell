import { PLUGIN_API_VERSION, type PluginHost } from "@subshell-ai/plugin-api";
import { detectBinary } from "./binary-lookup.js";
import { shellQuote } from "./shell.js";
import { probeVersion } from "./version-probe.js";

/**
 * The host object a plugin is handed, because it can import none of this.
 *
 * Measured on bun 1.4.2: a compiled binary CAN import a module from disk at
 * runtime, and that module CANNOT resolve a bare specifier of ours, because
 * there is no `node_modules` beside it. So every service a plugin needs is
 * lent to it through this object rather than imported.
 *
 * A thin adapter over the functions beside it, and it should stay one. Logic
 * that lives here is logic a plugin cannot override or a test cannot see.
 */

/** What {@link createPluginHost} needs to know about the plugin it serves. */
export interface PluginHostOptions {
  /** Plugin id, used to namespace log lines back to their source. */
  pluginId: string;
  /** Sink for the plugin's own log lines (default: the console). */
  sink?: { debug(message: string): void; warn(message: string): void };
}

/**
 * Builds the host object for one plugin.
 * @param options - the plugin's id, and optionally where its logs go
 */
export function createPluginHost(options: PluginHostOptions): PluginHost {
  const sink = options.sink ?? {
    debug: (m: string) => console.debug(`[plugin ${options.pluginId}] ${m}`),
    warn: (m: string) => console.warn(`[plugin ${options.pluginId}] ${m}`),
  };
  return {
    apiVersion: PLUGIN_API_VERSION,
    findBinary: async (name, envOverride, knownPaths) => (await detectBinary(name, envOverride, knownPaths)).path,
    detectBinary: (name, envOverride, knownPaths) => detectBinary(name, envOverride, knownPaths),
    probeVersion: (binary, args) => probeVersion(binary, args),
    shellQuote,
    log: sink,
  };
}
