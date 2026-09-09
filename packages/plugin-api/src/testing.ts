import type { PluginHost } from "./types.js";

/**
 * A host for a plugin's own tests.
 *
 * The real host lives in `@internal/pane-runtime`, which a plugin package
 * cannot depend on: knowing only this contract is the whole point of it. So a
 * plugin's tests need a stand-in, and without this every plugin package
 * carries its own copy. That is five edits every time {@link PluginHost} gains
 * a member, on the type whose own docstring says members are only ever added.
 *
 * Deliberately inert: every service answers "nothing found". A test that needs
 * a real answer passes one in, which also documents what it depends on.
 */
export function createTestHost(over: Partial<PluginHost> = {}): PluginHost {
  return {
    apiVersion: 1,
    findBinary: async () => null,
    detectBinary: async () => ({ path: null, reason: "not-on-path" }),
    probeVersion: async () => null,
    // The same POSIX quoting the real host lends, so a plugin that formats a
    // command in a test formats it the same way at runtime.
    shellQuote: (value: string) => `'${value.replaceAll("'", `'\\''`)}'`,
    log: { debug: () => {}, warn: () => {} },
    ...over,
  };
}
