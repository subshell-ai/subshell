import { readMcpEnv } from "@internal/mcp-core";
import { licenseNotice, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { type AgentConfig, configPath, loadConfig } from "./config.js";
import { probeOnline, runDaemon } from "./daemon.js";
import { runEnroll } from "./enroll.js";
import { clearLock, isPidAlive, readLock } from "./lock.js";
import { runAgentMcp } from "./mcp/main.js";
import {
  controlService,
  DEFAULT_DEPS,
  installService,
  isServiceVerb,
  queryService,
  SERVICE_VERBS,
  type ServiceDeps,
  serviceStateLines,
  uninstallService,
} from "./service.js";
import { AGENT_VERSION } from "./version.js";

/** Collected output + exit code instead of direct stdio writes, so tests assert both. */
export interface CliResult {
  /** Process exit code (0 ok, 1 runtime failure, 2 usage, 3 not-implemented stub). */
  code: number;
  /** Text for stdout. */
  out: string;
  /** Text for stderr. */
  err: string;
  /**
   * The invocation started a process-lifetime handle — the MCP stdio
   * transport — whose completion IS the success condition: `connect()`
   * resolves once attached and the SDK's stdin listener is what keeps the
   * process alive. An entry that sees this MUST NOT write or exit; exiting
   * would kill the live transport (the T18 parity bug).
   */
  keepAlive?: boolean;
}

const USAGE = `subshell — node agent daemon

usage:
  subshell enroll --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>] [--json]
  subshell run
  subshell service install|uninstall   (systemd user unit / launchd agent)
  subshell service status [--json]     (what the service manager reports)
  subshell service start|stop|restart  (restart takes --force: override the live-pane refusal)
  subshell status [--json] [--probe]
  subshell version        (also --version, -v)
  subshell license        print the copyright and licence and exit
  subshell mcp            (stdio MCP server for a subshell pane — internal)
`;

/** Malformed invocation → usage text, exit 2. */
class UsageError extends Error {}

const COMMANDS = new Set(["enroll", "license", "mcp", "run", "service", "status", "version"]);
/**
 * Bare flags accepted IN THE COMMAND SLOT. argv[0] is the command here, so
 * `subshell --version` would otherwise die as `unknown command '--version'`
 * — accurate about the parser, useless to whoever typed the one thing every
 * other CLI answers. The alias is confined to the FIRST token on purpose:
 * `--version` stays an unknown flag everywhere else, because
 * `subshell status --version` is a typo, not a request for the version.
 */
const COMMAND_ALIASES: Record<string, string> = {
  "--version": "version",
  "-v": "version",
};
/**
 * Command → bare subtoken accepted in its FIRST positional slot (validated
 * there). The manager verbs are spread from `service.ts` so a verb added there
 * cannot be silently unreachable here.
 */
const SUBCOMMANDS: Record<string, string[]> = {
  service: ["install", "uninstall", "status", ...SERVICE_VERBS],
};
/**
 * Command → subtoken → the flags THAT subtoken accepts. `service` is the only
 * command whose flags are per-subcommand: `--json` is a view's flag and
 * `--force` only ever overrides the restart refusal, so accepting either
 * everywhere under `service` would make `service install --force` read as
 * meaningful.
 */
const SUBCOMMAND_FLAGS: Record<string, Record<string, string[]>> = {
  service: { status: ["--json"], restart: ["--force"] },
};
/** Known flag → does it take a value? */
const FLAGS: Record<string, boolean> = {
  "--server": true,
  "--key": true,
  "--name": true,
  "--data-dir": true,
  "--json": false,
  "--probe": false,
  "--force": false,
};
/** Every flag any subtoken of `command` accepts — the union {@link SUBCOMMAND_FLAGS} narrows. */
const subcommandFlagUnion = (command: string): string[] => [
  ...new Set(Object.values(SUBCOMMAND_FLAGS[command] ?? {}).flat()),
];
const COMMAND_FLAGS: Record<string, string[]> = {
  enroll: ["--server", "--key", "--name", "--data-dir", "--json"],
  license: [],
  mcp: [], // no flags — everything comes from the SUBSHELL_* pane env (the @internal/mcp-core env.ts contract)
  run: [],
  // Derived, never hand-listed: the command-level check is the union and the
  // per-subtoken check below is what actually decides.
  service: subcommandFlagUnion("service"),
  status: ["--json", "--probe"],
  version: [],
};

const flagKey = (flag: string): string => flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Parsed CLI invocation — `sub` is set only for commands with a SUBCOMMANDS entry. */
export interface ParsedArgs {
  /** Top-level command (a member of {@link COMMANDS}). */
  command: string;
  /** Bare first positional, validated against the command's {@link SUBCOMMANDS} list. */
  sub?: string;
  /** Flag map (camelCased key, `"1"` for booleans). */
  flags: Record<string, string>;
}

/** Hand-rolled flag map (precedent: backend mcp entry) — no dependency needed for a handful of flags. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (!first) throw new UsageError("no command given");
  const command = COMMAND_ALIASES[first] ?? first;
  // Reports what was TYPED, not what it aliased to — an unknown token is
  // still `unknown command '--bogus'`.
  if (!COMMANDS.has(command)) throw new UsageError(`unknown command '${first}'`);
  const flags: Record<string, string> = {};
  const allowed = new Set(COMMAND_FLAGS[command]);
  // The FIRST bare (non-`--`) token is the subtoken slot — only commands with a
  // SUBCOMMANDS entry may see one, and only one; a second bare token falls
  // through to the flag arm below and dies as `unknown flag`.
  const subcommands = SUBCOMMANDS[command];
  let sub: string | undefined;
  // Raw tokens as typed (`flags` is camelCased and lossy) — the per-subtoken
  // check below reports the flag the way the operator wrote it.
  const used: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (subcommands && sub === undefined && !rest[i].startsWith("--")) {
      if (!subcommands.includes(rest[i])) {
        throw new UsageError(
          `unknown ${command} subcommand '${rest[i]}' — ${command} requires ${subcommands.join(" or ")}`,
        );
      }
      sub = rest[i];
      continue;
    }
    // `--flag=value` is accepted alongside `--flag value` (split on the FIRST
    // "=", so a value may itself contain "="); usage text keeps showing the
    // space form.
    const eq = rest[i].startsWith("--") ? rest[i].indexOf("=") : -1;
    const tok = eq === -1 ? rest[i] : rest[i].slice(0, eq);
    const inlineValue = eq === -1 ? undefined : rest[i].slice(eq + 1);
    if (!(tok in FLAGS)) throw new UsageError(`unknown flag '${tok}'`);
    if (!allowed.has(tok)) throw new UsageError(`flag '${tok}' is not valid for '${command}'`);
    used.push(tok);
    if (!FLAGS[tok]) {
      if (inlineValue !== undefined) throw new UsageError(`flag '${tok}' takes no value`);
      flags[flagKey(tok)] = "1";
      continue;
    }
    if (inlineValue !== undefined) {
      if (inlineValue === "") throw new UsageError(`flag '${tok}' requires a value`);
      flags[flagKey(tok)] = inlineValue;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`flag '${tok}' requires a value`);
    flags[flagKey(tok)] = value;
  }
  if (subcommands && sub === undefined) {
    throw new UsageError(`${command} requires ${subcommands.join(" or ")}`);
  }
  if (sub !== undefined) assertSubcommandFlags(command, sub, used);
  return { command, sub, flags };
}

/**
 * Rejects a flag that the COMMAND accepts but this SUBTOKEN does not
 * (`service install --json`), naming the subcommand that does accept it —
 * without that hint the refusal reads as "this flag does not exist".
 * @throws UsageError (exit 2) on the first stray flag
 */
function assertSubcommandFlags(command: string, sub: string, used: string[]): void {
  const perSub = SUBCOMMAND_FLAGS[command];
  if (!perSub) return;
  const allowed = new Set(perSub[sub] ?? []);
  const stray = used.find((tok) => !allowed.has(tok));
  if (stray === undefined) return;
  const owners = Object.entries(perSub)
    .filter(([, list]) => list.includes(stray))
    .map(([name]) => `'${command} ${name}'`);
  const hint = owners.length > 0 ? ` — only ${owners.join(" and ")} accepts it` : "";
  throw new UsageError(`flag '${stray}' is not valid for '${command} ${sub}'${hint}`);
}

/**
 * Injectable effects for {@link run} — empty in production, where every field
 * falls back to the live process. The CLI tests use it to drive `service …`
 * against stubbed manager/filesystem seams instead of the real systemd or
 * launchd on whatever machine the suite happens to run on.
 */
export interface RunDeps {
  /** Service-manager + filesystem seams for `service` (default: {@link DEFAULT_DEPS}). */
  service?: ServiceDeps;
}

/**
 * Runs one CLI invocation and returns what to print + the exit code.
 * Never throws for expected failures; the messages are operator-actionable.
 */
export async function run(argv: string[], deps: RunDeps = {}): Promise<CliResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return fail(2, err);
  }
  try {
    switch (parsed.command) {
      case "version":
        return { code: 0, out: `subshell ${AGENT_VERSION} (node protocol v${NODE_PROTOCOL_VERSION})\n`, err: "" };
      // Separate from `version` on purpose: `version` is a machine contract
      // (the release smoke matches it, scripts parse it), and this binary
      // ships as a bare single file with no LICENSE beside it — so this
      // subcommand is how a recipient gets the terms both licences oblige us
      // to hand over.
      case "license":
        return { code: 0, out: licenseNotice("subshell", AGENT_VERSION), err: "" };
      case "mcp": {
        // The stdio MCP server for one subshell pane (spec §6.4). It is NOT
        // an enrolled-daemon command: no config, no lock, no socket — just the
        // SUBSHELL_* env the launch injected. Missing env is a usage error: exit 2
        // with the actionable line (readMcpEnv's message names the variable),
        // before a single byte touches stdio.
        try {
          readMcpEnv();
        } catch (err) {
          return fail(2, err);
        }
        await runAgentMcp();
        // REACHABLE, and not the end: `connect()` resolves as soon as the
        // stdio transport attaches, so this await returns while the server is
        // still live. keepAlive is the contract that stops the entry from
        // exiting (main.ts) — exiting here killed the transport pre-T18-fix.
        return { code: 0, out: "", err: "", keepAlive: true };
      }
      case "run": {
        // The daemon is a foreground process that owns its own lifetime: it
        // logs its one-line entries (plain console, not CliResult) and exits
        // only through runDaemon's injected exit hook. loadConfig() still
        // throws the enroll-pointing message through this path.
        const cfg = await loadConfig();
        await runDaemon(cfg);
        return { code: 0, out: "", err: "" }; // unreachable: runDaemon never resolves (test seam only)
      }
      case "service": {
        // Backgrounding via the platform service manager (spec §11), plus the
        // manager-driving verbs a GUI needs. parseArgs already pinned `sub` to
        // a SUBCOMMANDS.service member; the real deps wire the config check to
        // loadConfig() so service.ts stays config-import-free.
        const sdeps = deps.service ?? DEFAULT_DEPS(configExists);
        if (parsed.sub === "install") return await installService(sdeps);
        if (parsed.sub === "uninstall") return await uninstallService(sdeps);
        if (parsed.sub === "status") {
          // A VIEW, not a command: it always exits 0 (the `subshell-server
          // service status` rule) so a caller polling it — the desktop GUI —
          // never has to tell "the daemon is not running" apart from "the call
          // itself failed". Nothing here can echo the node key: the state is
          // read from the service manager, which has never seen it.
          const state = await queryService(sdeps);
          const out = parsed.flags.json
            ? `${JSON.stringify(state, null, 2)}\n`
            : `${serviceStateLines(state).join("\n")}\n`;
          return { code: 0, out, err: "" };
        }
        // Narrowed by exclusion — install/uninstall/status returned above — so
        // a SUBCOMMANDS.service entry that nothing handles lands on the usage
        // error below instead of silently restarting the daemon.
        if (parsed.sub !== undefined && isServiceVerb(parsed.sub)) {
          return await controlService(sdeps, parsed.sub, { force: parsed.flags.force === "1" });
        }
        throw new UsageError(`unknown service subcommand '${parsed.sub ?? ""}'`);
      }
      case "enroll": {
        const server = parsed.flags.server;
        const key = parsed.flags.key;
        const missing: string[] = [];
        if (!server) missing.push("--server <url>");
        if (!key) missing.push("--key <nsk_…>");
        if (missing.length > 0) throw new UsageError(`enroll requires ${missing.join(" and ")}`);
        const enrolled = await runEnroll({
          server,
          setupKey: key,
          name: parsed.flags.name,
          dataDir: parsed.flags.dataDir,
        });
        if (parsed.flags.json) {
          // What a GUI would otherwise screen-scrape off the human line, plus
          // the two paths it cannot derive. The nodeKey is NEVER here: the
          // 0600 config file is its only home (same rule as `status --json`).
          const body = {
            nodeId: enrolled.nodeId,
            serverUrl: enrolled.serverUrl,
            name: enrolled.name,
            dataDir: enrolled.dataDir,
            configPath: configPath(),
          };
          return { code: 0, out: `${JSON.stringify(body, null, 2)}\n`, err: "" };
        }
        return { code: 0, out: `Enrolled as ${enrolled.nodeId} — next: subshell run\n`, err: "" };
      }
      case "status": {
        // NON-DESTRUCTIVE by default (fix wave 1): a live `daemon.lock` (pid alive, same
        // nodeId) answers ONLINE locally — the plane is never dialed. A stale lock (dead
        // pid) is cleaned. With NO lock the honest answer is OFFLINE; `--probe` is the
        // explicit opt-in to the WS connect probe, which can supersede-kick a remote-run
        // agent (registry newest-wins) and says so loudly on stderr. Exit 0 iff online.
        // The nodeKey is NEVER echoed — not even via --json; the 0600 config file is its only home.
        let cfg: AgentConfig;
        try {
          cfg = await loadConfig();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!parsed.flags.json) return fail(1, err);
          const missing = { nodeId: null, serverUrl: null, online: false, agentVersion: AGENT_VERSION, reason };
          return { code: 1, out: `${JSON.stringify(missing, null, 2)}\n`, err: "" };
        }
        let lock = readLock();
        if (lock && lock.nodeId !== cfg.nodeId) {
          lock = null; // another node's lock in this home: never trust, never delete
        } else if (lock && !isPidAlive(lock.pid)) {
          clearLock(lock.pid); // ours, but the daemon is gone: stale — clean up
          // (pid-keyed: if a daemon re-wrote the lock between read and clear, the
          // pids diverge and the live lock survives this cleanup.)
          lock = null;
        }
        let online = false;
        let daemonAgeMs: number | undefined;
        let probe: boolean | undefined;
        let line: string;
        let errOut = "";
        if (lock) {
          online = true;
          daemonAgeMs = Math.max(0, Date.now() - Date.parse(lock.lastTickAt));
          line = `node ${cfg.nodeId} "${cfg.name}" — ONLINE (local daemon pid ${lock.pid}, last heartbeat ${fmtAge(daemonAgeMs)} ago)`;
        } else if (parsed.flags.probe) {
          errOut =
            "subshell: --probe opens a live node socket — the control plane keeps the NEWEST " +
            "connection, so this KICKS any subshell running elsewhere for this node (terminal " +
            "4409 for it). Only probe when you are certain no other agent is running.\n";
          probe = await probeOnline(cfg);
          online = probe;
          line = online
            ? `node ${cfg.nodeId} "${cfg.name}" — ONLINE (probe: a socket to ${cfg.serverUrl} opened)`
            : `node ${cfg.nodeId} "${cfg.name}" — OFFLINE (probe: no socket to ${cfg.serverUrl} within 5 s)`;
        } else {
          line =
            `node ${cfg.nodeId} "${cfg.name}" — OFFLINE (no local subshell running; ` +
            `start one with \`subshell run\`, or pass --probe to ask the control plane — ` +
            `a probe KICKS a remote agent!)`;
        }
        if (parsed.flags.json) {
          const body = {
            nodeId: cfg.nodeId,
            serverUrl: cfg.serverUrl,
            online,
            agentVersion: AGENT_VERSION,
            ...(daemonAgeMs !== undefined ? { daemonAgeMs } : {}),
            ...(probe !== undefined ? { probe } : {}),
          };
          return { code: online ? 0 : 1, out: `${JSON.stringify(body, null, 2)}\n`, err: errOut };
        }
        return { code: online ? 0 : 1, out: `${line}\n`, err: errOut };
      }
    }
  } catch (err) {
    return err instanceof UsageError ? fail(2, err) : fail(1, err);
  }
  return fail(2, new UsageError(`unknown command '${parsed.command}'`));
}

/** The service deps' config probe: existence is `loadConfig()` resolving (any throw ⇒ absent/corrupt). */
async function configExists(): Promise<boolean> {
  try {
    await loadConfig();
    return true;
  } catch {
    return false;
  }
}

/** Human-friendly age for the ONLINE line ("4.2 s", "850 ms"). */
function fmtAge(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fail(code: number, err: unknown): CliResult {
  const message = err instanceof Error ? err.message : String(err);
  return { code, out: "", err: `subshell: ${message}\n${code === 2 ? `\n${USAGE}` : ""}` };
}
