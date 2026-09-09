import type { PluginHost } from "@subshell-ai/plugin-api";

/**
 * A host for tests that exercise the plugin directly.
 *
 * The real one lives in `@internal/pane-runtime`, which a plugin package
 * cannot depend on: the whole point of the contract is that a plugin knows
 * only `@subshell-ai/plugin-api`. So a plugin's own tests bring their own
 * host, and this stub is deliberately minimal.
 */
export function createPluginHost(over: Partial<PluginHost> = {}): PluginHost {
  return {
    apiVersion: 1,
    findBinary: async () => null,
    detectBinary: async () => ({ path: null, reason: "not-on-path" }),
    probeVersion: async () => null,
    shellQuote: (v) => `'${v.replaceAll("'", `'\\''`)}'`,
    log: { debug: () => {}, warn: () => {} },
    ...over,
  };
}
