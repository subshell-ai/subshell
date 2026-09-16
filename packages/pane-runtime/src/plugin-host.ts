import { homedir } from "node:os";
import { PLUGIN_API_VERSION, type PluginHost, type PluginPlatform, type PluginSecrets } from "@subshell-ai/plugin-api";
import { detectBinary } from "./binary-lookup.js";
import { createPluginSecrets } from "./plugin-secrets.js";
import { runBounded } from "./run-bounded.js";
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
 * that lives here is logic a plugin cannot override or a test cannot see. The
 * two REFUSALS in `run` are the exception and are deliberate: they are not
 * logic a plugin should be able to override, which is exactly why they are
 * here rather than in the plugin.
 */

/** What {@link createPluginHost} needs to know about the plugin it serves. */
export interface PluginHostOptions {
  /** Plugin id, used to namespace log lines back to their source. */
  pluginId: string;
  /** Sink for the plugin's own log lines (default: the console). */
  sink?: { debug(message: string): void; warn(message: string): void };
  /**
   * The server's data directory, which is what a secret store needs.
   *
   * Optional because the node agent builds hosts too and has no network
   * plugins: without it, `secrets` refuses every call by name rather than
   * writing somewhere invented. A harness plugin never touches it.
   *
   * Defaults to whatever {@link setPluginDataDir} was told, which is how the
   * synchronous registry (built at first use, from call sites that have no
   * data dir to hand) still produces plugins with a store.
   */
  dataDir?: string;
}

/**
 * The data directory hosts use when a caller names none.
 *
 * Module state because there is exactly one of these per process and roughly
 * ten synchronous registry call sites would otherwise have to carry it. The
 * node agent never calls the setter, so its hosts keep no store at all — the
 * same structural safety the installed-plugin overlay relies on.
 */
let defaultDataDir: string | undefined;

/**
 * Names the data directory every later host uses by default.
 *
 * Called once, at boot, before anything reads the plugin registry. Hosts built
 * BEFORE it are unaffected, which is why it runs early rather than lazily.
 * @param dataDir - the server's data directory
 */
export function setPluginDataDir(dataDir: string): void {
  defaultDataDir = dataDir;
}

/**
 * Forgets the default data directory.
 * @internal
 */
export function resetPluginDataDirForTests(): void {
  defaultDataDir = undefined;
}

/**
 * The only two argv shapes `run` refuses, and why each is refused rather than
 * left to fail on its own.
 *
 * A BARE executable name would be resolved against a PATH the plugin cannot
 * see and did not choose — including the login-shell entries the host adds —
 * so "which binary did this plugin just run" would have no answer. Plugins
 * resolve with `findBinary` and pass what it returned.
 *
 * `sudo` is refused because the server has no terminal behind the request and
 * runs the child with stdin closed, so a privileged command would sit on a
 * password prompt until the deadline and report a timeout for what was really
 * a missing password. Refusing it is also what keeps "the server sets up your
 * network" from meaning "the server escalates": privileged steps are manifest
 * data (`network.privileged`) that a page prints for a human to run.
 */
function refuseArgv(pluginId: string, argv: readonly string[]): string | undefined {
  const [command] = argv;
  if (command === undefined || command.trim() === "") return "run() needs a command";
  if (!command.startsWith("/")) {
    return `run() needs an absolute path, not "${command}" — resolve it with findBinary() first`;
  }
  const base = command.slice(command.lastIndexOf("/") + 1);
  if (base === "sudo" || base === "doas" || base === "pkexec") {
    return `plugin "${pluginId}" tried to run ${base}; the server has no terminal to answer a password prompt, so privileged steps belong in the manifest's network.privileged where they are shown to copy`;
  }
  return undefined;
}

/** A secret store for a host with no data directory: refuses, never invents a path. */
function unavailableSecrets(pluginId: string): PluginSecrets {
  const refuse = () => {
    throw new Error(`plugin "${pluginId}" has no secret store here: this host was built without a data directory`);
  };
  return {
    set: async () => refuse(),
    // Not a throw: "is this configured" is a question a status probe asks on
    // every page load, and a host with no store simply has no secrets.
    has: async () => false,
    delete: async () => refuse(),
  };
}

/**
 * This host's operating system, in the manifest's vocabulary.
 *
 * Anything that is neither darwin nor linux reports `linux`, because the two
 * platforms this project ships on are the two the manifest can name — and a
 * third would be refused by the platform gate anyway, one layer up, where the
 * refusal can say so.
 */
export function hostPlatform(): PluginPlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/**
 * Builds the host object for one plugin.
 * @param options - the plugin's id, where its logs go, and its data directory
 */
export function createPluginHost(options: PluginHostOptions): PluginHost {
  const sink = options.sink ?? {
    debug: (m: string) => console.debug(`[plugin ${options.pluginId}] ${m}`),
    warn: (m: string) => console.warn(`[plugin ${options.pluginId}] ${m}`),
  };
  const dataDir = options.dataDir ?? defaultDataDir;
  return {
    apiVersion: PLUGIN_API_VERSION,
    findBinary: async (name, envOverride, knownPaths) => (await detectBinary(name, envOverride, knownPaths)).path,
    detectBinary: (name, envOverride, knownPaths) => detectBinary(name, envOverride, knownPaths),
    probeVersion: (binary, args) => probeVersion(binary, args),
    shellQuote,
    log: sink,
    run: async (argv, opts) => {
      const refusal = refuseArgv(options.pluginId, argv);
      // THROWN, not returned as a failed result: both refusals are bugs in the
      // plugin rather than outcomes of running something, and a plugin that
      // saw them as "the command failed" would render them to an operator as
      // the vendor's problem.
      if (refusal !== undefined) throw new Error(refusal);
      const { code, stdout, stderr, timedOut, aborted } = await runBounded(argv, opts);
      return { code, stdout, stderr, timedOut, aborted };
    },
    secrets:
      dataDir === undefined ? unavailableSecrets(options.pluginId) : createPluginSecrets(dataDir, options.pluginId),
    platform: hostPlatform(),
    homeDir: homedir(),
  };
}
