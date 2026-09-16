import { PLUGIN_API_VERSION } from "./manifest.js";
import { type PluginHost, type RunResult, shellQuote } from "./types.js";

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
    apiVersion: PLUGIN_API_VERSION,
    findBinary: async () => null,
    detectBinary: async () => ({ path: null, reason: "not-on-path" }),
    probeVersion: async () => null,
    // The real quoter, not a copy of it: a plugin that formats a command in a
    // test must format it identically at runtime, and a second implementation
    // is exactly how that stops being true.
    shellQuote,
    log: { debug: () => {}, warn: () => {} },
    // "Nothing ran", not "it worked": a network plugin's test that forgets to
    // script an answer sees an empty status rather than a passing publish.
    run: async () => ({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false }),
    secrets: { set: async () => {}, has: async () => false, delete: async () => {} },
    platform: "linux",
    homeDir: "/home/test",
    ...over,
  };
}

/**
 * Scripts {@link PluginHost.run} from a table of command lines to answers.
 *
 * A network plugin is mostly a parser of one vendor CLI, so its tests are
 * mostly "given this `status --json`, report that state". Matching on the
 * joined argv keeps those tests readable and makes an unexpected command a
 * visible failure rather than a silent empty answer.
 * @param answers - joined argv (or a prefix of it) → what that run reports
 * @param over - anything else to override on the host
 */
export function createScriptedHost(
  answers: Record<string, Partial<RunResult>>,
  over: Partial<PluginHost> = {},
): PluginHost & { calls: string[][] } {
  const calls: string[][] = [];
  const host = createTestHost({
    findBinary: async (name) => `/usr/bin/${name}`,
    run: async (argv) => {
      calls.push([...argv]);
      const line = argv.join(" ");
      const key = Object.keys(answers).find((k) => line === k || line.startsWith(k));
      const answer = key === undefined ? {} : answers[key];
      return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...answer };
    },
    ...over,
  });
  return Object.assign(host, { calls });
}
