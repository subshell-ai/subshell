import { ATTENTION_KINDS, REPORT_VERBS, readMcpEnv, runReport } from "@internal/mcp-core";
import { licenseNotice, NODE_PROTOCOL_VERSION, semverLt } from "@internal/subshell-protocol";
import { configPath, loadConfig, type NodeConfig } from "./config.js";
import { runConfigure } from "./configure.js";
import { probeOnline, runDaemon } from "./daemon.js";
import { runEnroll } from "./enroll.js";
import { clearLock, isPidAlive, lockPath, readLock } from "./lock.js";
import { logger } from "./log.js";
import { agentLogPath } from "./log-file.js";
import { tightenServiceLogMode } from "./log-hygiene.js";
import {
  defaultMaintenanceDeps,
  isMaintenanceSub,
  MAINTENANCE_SUBS,
  type MaintenanceDeps,
  runMaintenance,
} from "./maintenance-cli.js";
import { runNodeMcp } from "./mcp/main.js";
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
import { type ConfirmFn, type PromptTextFn, promptConfirm, promptName, runSetup } from "./setup.js";
import {
  applyUpdate,
  failedMarkerPath,
  pendingMarkerPath,
  probeFileVersion,
  readMarker,
  resolveNodeBinaryPath,
  resolveNodeRelease,
  rollbackUpdate,
  type UpdateFailure,
} from "./update.js";
import { NODE_VERSION } from "./version.js";

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

const USAGE = `subshell: node daemon

usage:
  subshell setup --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>]
                 [--no-service] [--yes] [--json]
                          the whole enrollment: checks tmux, asks what to call
                          this machine, enrolls, then offers to run it in the
                          background and start it at login. Without --name it ASKS (default:
                          the hostname); --yes, --json or no terminal make the
                          name required instead. --no-service skips the service
                          question; --yes / a non-TTY take its default (yes).
  subshell enroll --server <url> --key <nsk_…> --name <n> [--data-dir <d>] [--json]
                          enrollment ONLY — the primitive that setup composes; it
                          asks nothing, so --name is required
  subshell configure --server <url> [--json]
                          repoint an ALREADY-enrolled node at a different control
                          plane. Keeps this node's identity and spends no setup
                          key; restart the node to apply. Does NOT rename: the
                          plane owns a node's name (the Nodes page).
  subshell run
  subshell service install [--no-autostart]   (systemd user unit / launchd agent)
                          --no-autostart runs it now but not at login
  subshell service uninstall
  subshell service status [--json]     (what the service manager reports)
  subshell service start|stop|restart  (restart takes --force: override the live-pane refusal)
  subshell maintenance on [--yes] [--json]
                          take this node out of service: it answers everything
                          else, launches nothing, and STOPS every subshell
                          running here (listed first; --yes is the confirmation)
  subshell maintenance off [--json]     put it back in service
  subshell maintenance status [--json]  what this machine's mirror says
  subshell status [--json] [--probe]
  subshell update [--check] [--to <version>] [--from <file>] [--force] [--yes]
                  [--json] [--no-restart]
                          replace this node's own binary with a newer one and
                          restart into it. --check only says what is available.
                          --from installs a local file instead of downloading.
                          --force allows a downgrade, and overrides the
                          live-pane restart refusal.
  subshell update --rollback [--yes] [--json]
                          put <binary>.previous back, if an update left one
  subshell version        (also --version, -v)
  subshell license        print the copyright and licence and exit
  subshell mcp            (stdio MCP server for a subshell pane, internal)
  subshell report attention turn_complete|needs_attention
  subshell report session (a pane's state, run by harness hooks — not by hand)
`;

/** Malformed invocation → usage text, exit 2. */
class UsageError extends Error {}

const COMMANDS = new Set([
  "configure",
  "enroll",
  "license",
  "maintenance",
  "mcp",
  "report",
  "run",
  "service",
  "setup",
  "status",
  "update",
  "version",
]);
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
  // Spread for the same reason: a subtoken added in maintenance-cli.ts must
  // not be silently unreachable from the parser that admits it.
  maintenance: [...MAINTENANCE_SUBS],
  // Spread from mcp-core so the CLI cannot accept a verb the reporter does not
  // implement — or refuse one it does.
  report: [...REPORT_VERBS],
};
/**
 * Command → subtoken → the values its SECOND positional accepts. A subtoken
 * absent from its command's entry takes no argument at all, and one present
 * requires exactly one: both are usage errors, because a hook that typed the
 * wrong word must fail loudly here rather than report the wrong thing.
 *
 * Only `report attention <kind>` needs the slot today. It exists as a table
 * rather than a special case so the next two-word verb is data, and it stays
 * ONE extra slot deliberately — a general grammar for a CLI with one such
 * command would be more machinery than the CLI.
 */
const SUBCOMMAND_ARGS: Record<string, Record<string, readonly string[]>> = {
  report: { attention: ATTENTION_KINDS },
};
/**
 * Command → subtoken → the flags THAT subtoken accepts. `--json` is a VIEW's
 * flag and `--force` only ever overrides the restart refusal, so accepting
 * either everywhere under `service` would make `service install --force` read
 * as meaningful.
 */
const SUBCOMMAND_FLAGS: Record<string, Record<string, string[]>> = {
  // `--no-autostart` is install's alone: it decides what the NEXT login does,
  // and the manager verbs drive a definition whose login behaviour is already
  // written down.
  service: { install: ["--no-autostart"], status: ["--json"], restart: ["--force"] },
  // `--yes` overrides ONE refusal, the live-pane one `on` raises; `off` and
  // `status` have nothing to confirm, so accepting it there would read as
  // meaningful.
  maintenance: { on: ["--yes", "--json"], off: ["--json"], status: ["--json"] },
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
  "--yes": false,
  "--no-service": false,
  "--no-autostart": false,
  "--check": false,
  "--to": true,
  "--from": true,
  "--no-restart": false,
  "--rollback": false,
};
/** Every flag any subtoken of `command` accepts — the union {@link SUBCOMMAND_FLAGS} narrows. */
const subcommandFlagUnion = (command: string): string[] => [
  ...new Set(Object.values(SUBCOMMAND_FLAGS[command] ?? {}).flat()),
];
const COMMAND_FLAGS: Record<string, string[]> = {
  // No --key and no --data-dir: this command spends no setup key, and the
  // identity directory belongs to the enrollment that created it. No --name
  // either — see configure.ts: the plane never reads this file's name outside
  // the enroll body, so a rename here would be a lie.
  configure: ["--server", "--json"],
  enroll: ["--server", "--key", "--name", "--data-dir", "--json"],
  license: [],
  // Derived, never hand-listed — see `service` below.
  maintenance: subcommandFlagUnion("maintenance"),
  mcp: [], // no flags — everything comes from the SUBSHELL_* pane env (the @internal/mcp-core env.ts contract)
  report: [], // same pane-env contract; a hook's command line is built by the control plane, never typed
  run: [],
  // Derived, never hand-listed: the command-level check is the union and the
  // per-subtoken check below is what actually decides.
  service: subcommandFlagUnion("service"),
  // enroll's flags plus the two that govern the step enroll does not have.
  // `--no-service` lives ONLY here: `enroll` has no service step to opt out
  // of, so accepting it there would read as meaningful.
  setup: ["--server", "--key", "--name", "--data-dir", "--no-service", "--yes", "--json"],
  status: ["--json", "--probe"],
  // No subtoken table: `--rollback` is a FLAG rather than a `subshell update
  // rollback` subcommand, because it is the same verb pointed backwards and a
  // subcommand would invite `update rollback --to 0.8.0`, which means nothing.
  update: ["--check", "--to", "--from", "--force", "--yes", "--json", "--no-restart", "--rollback"],
  version: [],
};

const flagKey = (flag: string): string => flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Parsed CLI invocation — `sub` is set only for commands with a SUBCOMMANDS entry. */
export interface ParsedArgs {
  /** Top-level command (a member of {@link COMMANDS}). */
  command: string;
  /** Bare first positional, validated against the command's {@link SUBCOMMANDS} list. */
  sub?: string;
  /** Bare second positional, validated against {@link SUBCOMMAND_ARGS} for that subtoken. */
  arg?: string;
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
  // SUBCOMMANDS entry may see one, and only one; every later bare token falls
  // through to the flag arm below and dies as `unknown flag`. (The `plugin`
  // verbs were the only positional-taking subcommands; they left with the
  // node's plugin concept, inversion spec 2026-09-10 §6.)
  const subcommands = SUBCOMMANDS[command];
  let sub: string | undefined;
  // The SECOND bare token, for the `<command> <sub> <arg>` shapes in
  // {@link SUBCOMMAND_ARGS}. Anything beyond it still falls through to the
  // flag arm and dies as `unknown flag`.
  let arg: string | undefined;
  // Raw tokens as typed (`flags` is camelCased and lossy) — the per-subtoken
  // check below reports the flag the way the operator wrote it.
  const used: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (subcommands && sub === undefined && !rest[i].startsWith("--")) {
      if (!subcommands.includes(rest[i])) {
        throw new UsageError(
          `unknown ${command} subcommand '${rest[i]}': ${command} requires ${subcommands.join(" or ")}`,
        );
      }
      sub = rest[i];
      continue;
    }
    if (sub !== undefined && arg === undefined && !rest[i].startsWith("--")) {
      const args = SUBCOMMAND_ARGS[command]?.[sub];
      if (!args) throw new UsageError(`${command} ${sub} takes no argument (got '${rest[i]}')`);
      if (!args.includes(rest[i])) {
        throw new UsageError(`unknown ${command} ${sub} argument '${rest[i]}': requires ${args.join(" or ")}`);
      }
      arg = rest[i];
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
  // A subtoken that declares an argument list must have been given one: the
  // caller is a generated hook command line, so a missing word is a bug on
  // this side, not something to guess a default for.
  const argValues = sub === undefined ? undefined : SUBCOMMAND_ARGS[command]?.[sub];
  if (argValues && arg === undefined) {
    throw new UsageError(`${command} ${sub} requires ${argValues.join(" or ")}`);
  }
  return { command, sub, ...(arg === undefined ? {} : { arg }), flags };
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
  const hint = owners.length > 0 ? `; only ${owners.join(" and ")} accepts it` : "";
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
  /**
   * tmux/meta/clock seams for `maintenance` (default: built over the enrolled
   * data dir). `maintenance on` kills panes, so the tests that pin WHAT it
   * kills must not need a tmux server on the host running them.
   */
  maintenance?: MaintenanceDeps;
  /**
   * How `setup` asks for the node's name (default: {@link promptName}, a clack
   * text input prefilled with this machine's hostname).
   */
  promptName?: PromptTextFn;
  /**
   * How `setup` asks its one question (default: {@link promptConfirm}, a clack
   * confirm). Tests inject a plain function, which is the whole point of the
   * seam — nothing has to parse a rendered prompt to know what was asked.
   */
  prompt?: ConfirmFn;
  /**
   * Can anything answer a question? Default: `process.stdin.isTTY`. False
   * takes every default IN SILENCE — a `curl … | bash` install and a CI
   * runner must never see a prompt, let alone block on one.
   */
  interactive?: boolean;
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
        return { code: 0, out: `subshell ${NODE_VERSION} (node protocol v${NODE_PROTOCOL_VERSION})\n`, err: "" };
      // Separate from `version` on purpose: `version` is a machine contract
      // (the release smoke matches it, scripts parse it), and this binary
      // ships as a bare single file with no LICENSE beside it — so this
      // subcommand is how a recipient gets the terms both licences oblige us
      // to hand over.
      case "license":
        return { code: 0, out: licenseNotice("subshell", NODE_VERSION), err: "" };
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
        await runNodeMcp();
        // REACHABLE, and not the end: `connect()` resolves as soon as the
        // stdio transport attaches, so this await returns while the server is
        // still live. keepAlive is the contract that stops the entry from
        // exiting (main.ts) — exiting here killed the transport pre-T18-fix.
        return { code: 0, out: "", err: "", keepAlive: true };
      }
      case "report": {
        // Out-of-band reporting from a harness hook (spec: mcp-core's
        // `report.ts`). Unlike `mcp` above, a missing pane env is NOT a usage
        // error here: nobody typed this, a hook did, and its exit code and
        // stderr land in the user's session. `runReport` swallows everything
        // and this returns 0 either way — a lost report costs one
        // notification, never a turn.
        await runReport(parsed.sub ? [parsed.sub, ...(parsed.arg ? [parsed.arg] : [])] : []);
        return { code: 0, out: "", err: "" };
      }
      case "run": {
        // The daemon is a foreground process that owns its own lifetime: it
        // logs its one-line entries (plain console, not CliResult) and exits
        // only through runDaemon's injected exit hook. loadConfig() still
        // throws the enroll-pointing message through this path.
        const cfg = await loadConfig();
        // AFTER loadConfig and before the daemon: launchd creates its redirect
        // 0644 and this is the process that can repair it (see
        // `log-hygiene.ts`). Here rather than inside `runDaemon` because the
        // daemon's own tests call that function directly with hand-built deps,
        // and a repair reachable from them would chmod the developer's real
        // `~/Library/Logs/subshell.log` — which the `DEFAULT_DEPS` guard would
        // then refuse, silently, in the one place nobody reads.
        const hygiene = await tightenServiceLogMode(deps.service ?? DEFAULT_DEPS(configExists));
        if (hygiene.reason === "failed") {
          logger.withError(hygiene.error).warn(`could not tighten ${hygiene.path} to 0600`);
        }
        await runDaemon(cfg);
        return { code: 0, out: "", err: "" }; // unreachable: runDaemon never resolves (test seam only)
      }
      case "service": {
        // Backgrounding via the platform service manager (spec §11), plus the
        // manager-driving verbs a GUI needs. parseArgs already pinned `sub` to
        // a SUBCOMMANDS.service member; the real deps wire the config check to
        // loadConfig() so service.ts stays config-import-free.
        const sdeps = deps.service ?? DEFAULT_DEPS(configExists);
        // Default ON: start-at-login is what every install did before the
        // flag existed, and the service is started NOW either way.
        if (parsed.sub === "install") {
          return await installService(sdeps, { autostart: parsed.flags.noAutostart !== "1" });
        }
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
      case "maintenance": {
        // Config first: the mirror lives in the enrolled data dir, so a node
        // that was never enrolled has nowhere to put the flag — loadConfig's
        // own message is the one that points at `enroll`.
        const cfg = await loadConfig();
        if (parsed.sub === undefined || !isMaintenanceSub(parsed.sub)) {
          throw new UsageError(`unknown maintenance subcommand '${parsed.sub ?? ""}'`);
        }
        return await runMaintenance(
          cfg.dataDir,
          parsed.sub,
          { yes: parsed.flags.yes === "1", json: parsed.flags.json === "1" },
          deps.maintenance ?? defaultMaintenanceDeps(cfg.dataDir),
        );
      }
      case "setup": {
        // The composed enrollment (spec 2026-09-15 §4.5). Everything it does
        // lives elsewhere — assertTmux, runEnroll, installService — because
        // the defect was never a missing capability, only that nothing ran
        // them in order or pointed at the next one.
        const server = parsed.flags.server;
        const key = parsed.flags.key;
        const missing: string[] = [];
        if (!server) missing.push("--server <url>");
        if (!key) missing.push("--key <nsk_…>");
        if (missing.length > 0) throw new UsageError(`setup requires ${missing.join(" and ")}`);
        const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
        // `--name` is required of anything that cannot answer for it. The name is
        // asked ON THIS MACHINE now (the Add-node dialog stopped guessing it), and
        // a prompt needs a terminal — so `--yes`, `--json` and a piped install all
        // have to bring the name with them. Checked here, with the other argv
        // checks, so it reads as the usage error it is rather than as a runtime
        // refusal, and it stays ahead of the tmux preflight: an unusable command
        // line is nobody's machine's fault. `SUBSHELL_NODE_NAME` is how the
        // rendered one-liner supplies it, since `curl | bash` has no argv.
        // A blank `--name` IS no name — `--name ""` from a shell variable that
        // expanded to nothing must not become a usage error while the same script
        // with the flag omitted would have been asked. One rule for both, and
        // `runSetup` then asks exactly as it does for the absent case.
        const name = parsed.flags.name?.trim() ?? "";
        if (name === "" && (parsed.flags.json === "1" || parsed.flags.yes === "1" || !interactive)) {
          throw new UsageError(
            "setup requires --name <n> when nothing can be asked (--yes, --json, or no terminal); " +
              "the install one-liner takes it as SUBSHELL_NODE_NAME",
          );
        }
        return await runSetup(
          {
            server,
            setupKey: key,
            name,
            dataDir: parsed.flags.dataDir,
            noService: parsed.flags.noService === "1",
            assumeYes: parsed.flags.yes === "1",
            json: parsed.flags.json === "1",
          },
          {
            service: deps.service ?? DEFAULT_DEPS(configExists),
            promptName: deps.promptName ?? promptName,
            prompt: deps.prompt ?? promptConfirm,
            interactive,
          },
        );
      }
      case "enroll": {
        const server = parsed.flags.server;
        const key = parsed.flags.key;
        // The primitive asks nothing of anyone, so every fact arrives as an
        // argument — including the name. It used to default to the hostname here,
        // which is how a node ended up named after a machine nobody had asked.
        const missing: string[] = [];
        if (!server) missing.push("--server <url>");
        if (!key) missing.push("--key <nsk_…>");
        if (!parsed.flags.name?.trim()) missing.push("--name <n>");
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
        // Names the BACKGROUND path first. The old line was
        // "Next: subshell run", and `run` is a foreground daemon that dies
        // with the SSH session that started it — so the one sentence this
        // command had was pointing at the dead end. `run` stays named,
        // because trying it in this terminal is a real thing to want.
        return {
          code: 0,
          out:
            `Enrolled as ${enrolled.nodeId}.\n` +
            "Next: subshell service install   (background, starts at login)\n" +
            "      subshell run               (foreground, to try it in this terminal)\n",
          err: "",
        };
      }
      case "configure": {
        // A usage error, not a runtime one: "configure with no flags" is a
        // mistyped command, and the usage block is the answer to it. Every
        // other refusal here is the command's own (exit 1, no usage dump).
        const server = parsed.flags.server;
        if (server === undefined) throw new UsageError("configure requires --server <url>");
        const next = await runConfigure({ server });
        if (parsed.flags.json) {
          // Same rule as enroll/status --json: the nodeKey is NEVER here. A
          // GUI drives this command, so a leak would land the node's bearer
          // credential in a webview.
          const body = {
            nodeId: next.nodeId,
            serverUrl: next.serverUrl,
            name: next.name,
            dataDir: next.dataDir,
            configPath: configPath(),
          };
          return { code: 0, out: `${JSON.stringify(body, null, 2)}\n`, err: "" };
        }
        return {
          code: 0,
          out:
            `node ${next.nodeId} "${next.name}" now points at ${next.serverUrl}\n` +
            "restart the node to apply it: subshell service restart (or restart `subshell run`)\n",
          err: "",
        };
      }
      case "update": {
        // The one verb here that is async for a reason beyond house style: it
        // reaches the network and it swaps a file. `subshell-server update` is
        // the same shape and `AGENTS.md` names both as exceptions.
        const cfg = await loadConfig();
        const sdeps = deps.service ?? DEFAULT_DEPS(configExists);
        const json = parsed.flags.json === "1";

        if (parsed.flags.rollback === "1") {
          // --rollback is exclusive: every other flag names something about
          // going FORWARD, so accepting one beside it would read as meaningful.
          for (const flag of ["check", "to", "from", "noRestart"]) {
            if (parsed.flags[flag] !== undefined) {
              throw new UsageError(
                `--rollback cannot be combined with --${flag === "noRestart" ? "no-restart" : flag}`,
              );
            }
          }
          const { binary, to } = await rollbackUpdate(cfg.dataDir);
          const line = `rolled back to ${to} at ${binary}`;
          const restart = await controlService(sdeps, "restart", { force: parsed.flags.force === "1" });
          const note =
            restart.code === 0 ? "restarted the agent" : "restart it where you started it to run the previous version";
          if (json)
            return { code: 0, out: `${JSON.stringify({ rolledBack: true, binary, to, note }, null, 2)}\n`, err: "" };
          return { code: 0, out: `${line}\n${note}\n`, err: "" };
        }

        if (parsed.flags.from !== undefined && parsed.flags.to !== undefined) {
          throw new UsageError(
            "--from installs a file you name; --to picks a published release — use one or the other",
          );
        }

        // Where the bytes come from, and what version they claim to be. A
        // local file is asked directly (there is no digest to check on a path
        // an operator named); a release is resolved from the list.
        let offer: { version: string; source: Parameters<typeof applyUpdate>[0]["source"]; where: string };
        if (parsed.flags.from !== undefined) {
          const path = parsed.flags.from;
          offer = {
            version: await probeFileVersion(path),
            source: { kind: "file", path },
            where: path,
          };
        } else {
          const release = await resolveNodeRelease(parsed.flags.to);
          offer = {
            version: release.version,
            // The signed manifest `resolveNodeRelease` just verified travels
            // into the transaction, where `applyUpdate` verifies it AGAIN
            // beside the bytes it hashed — one rule, one implementation
            // (spec 2026-09-17 §5 path 1).
            source: { kind: "url", url: release.url, sha256: release.sha256, manifest: release.manifest },
            where: release.tag,
          };
        }

        // THE LINE THAT NAMES THE SHARPER ANSWER. This CLI holds no REST
        // credential (a node key does nothing there — security §5.5), so it
        // cannot ask its own plane which agent version that plane can talk to.
        // Saying so beats installing the newest and being closed 4406.
        const planeHint =
          parsed.flags.from === undefined
            ? "your control plane's Settings → Updates shows the version it can talk to; --to picks one\n"
            : "";

        if (parsed.flags.check === "1") {
          // SEMVER, not `!==`. The two answers differ exactly when the offer
          // is OLDER, and that is not a hypothetical: `MIN_NODE_VERSION` and
          // this package are bumped in the same commit as a protocol change,
          // so between that commit and the matching `cli-node-v*` cut the newest
          // published release IS older than the running agent. `!==` called
          // that "available" and a bare `subshell update` then downloaded
          // ~70 MB, swapped, restarted, and was held by the plane's own floor.
          // `subshell-server update` has always compared this way
          // (`commands/update.ts`); this is the half that had not.
          const available = semverLt(NODE_VERSION, offer.version);
          if (json) {
            const body = { installed: NODE_VERSION, latest: offer.version, updateAvailable: available };
            return { code: 0, out: `${JSON.stringify(body, null, 2)}\n`, err: "" };
          }
          const line = available
            ? `subshell ${offer.version} is available (${offer.where}); this agent is ${NODE_VERSION}`
            : `subshell ${NODE_VERSION} is the newest available`;
          return { code: 0, out: `${line}\n${planeHint}`, err: "" };
        }

        if (offer.version === NODE_VERSION) {
          const line = `already at subshell ${NODE_VERSION}`;
          if (json) {
            return {
              code: 0,
              out: `${JSON.stringify({ from: NODE_VERSION, to: NODE_VERSION, changed: false }, null, 2)}\n`,
              err: "",
            };
          }
          return { code: 0, out: `${line}\n`, err: "" };
        }

        // NEVER BACKWARDS by accident — the other half of the semver compare
        // above. An operator who means it says `--force`, the same word and
        // the same refusal `subshell-server update` uses; it is deliberately
        // not a silent no-op, because `--from <an older build>` is a real
        // thing to want and only the person holding the file knows why.
        if (semverLt(offer.version, NODE_VERSION) && parsed.flags.force !== "1") {
          return {
            code: 1,
            out: "",
            err: `subshell: ${offer.version} is older than the running ${NODE_VERSION}; pass --force to install it anyway\n`,
          };
        }

        // No prompt, the same shape `maintenance on` and `service restart
        // --force` have: this CLI asks nothing, so `--yes` is accepted (a
        // caller scripting the same line everywhere should not have to strip
        // it) and confirmation is the operator having typed the verb.
        const applied = await applyUpdate({
          source: offer.source,
          version: offer.version,
          force: parsed.flags.force === "1",
          restart: parsed.flags.noRestart !== "1",
          origin: "cli",
          dataDir: cfg.dataDir,
          restartService: (force) => controlService(sdeps, "restart", { force }),
        });
        if (json) {
          const body = {
            from: applied.from,
            to: applied.to,
            changed: true,
            binary: applied.binary,
            restarted: applied.restarted,
            ...(applied.note ? { note: applied.note } : {}),
          };
          return { code: 0, out: `${JSON.stringify(body, null, 2)}\n`, err: "" };
        }
        const lines = [`installed subshell ${applied.to} at ${applied.binary} (was ${applied.from})`];
        if (applied.restarted) lines.push("restarted the agent; it will reconnect on the new version");
        else if (parsed.flags.noRestart === "1")
          lines.push("not restarted (--no-restart); restart it to run the new version");
        else lines.push(applied.note ?? "restart it where you started it to run the new version");
        return { code: 0, out: `${lines.join("\n")}\n`, err: "" };
      }
      case "status": {
        // NON-DESTRUCTIVE by default (fix wave 1): a live `daemon.lock` (pid alive, same
        // nodeId) answers ONLINE locally — the plane is never dialed. A stale lock (dead
        // pid) is cleaned. With NO lock the honest answer is OFFLINE; `--probe` is the
        // explicit opt-in to the WS connect probe, which can supersede-kick a remote-run
        // agent (registry newest-wins) and says so loudly on stderr. Exit 0 iff online.
        // The nodeKey is NEVER echoed — not even via --json; the 0600 config file is its only home.
        let cfg: NodeConfig;
        try {
          cfg = await loadConfig();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!parsed.flags.json) return fail(1, err);
          const missing = { nodeId: null, serverUrl: null, online: false, agentVersion: NODE_VERSION, reason };
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
          line = `node ${cfg.nodeId} "${cfg.name}": ONLINE (local daemon pid ${lock.pid}, last heartbeat ${fmtAge(daemonAgeMs)} ago)`;
        } else if (parsed.flags.probe) {
          errOut =
            "subshell: --probe opens a live node socket, and the control plane keeps the NEWEST " +
            "connection, so this KICKS any subshell running elsewhere for this node (terminal " +
            "4409 for it). Only probe when you are certain no other agent is running.\n";
          probe = await probeOnline(cfg);
          online = probe;
          line = online
            ? `node ${cfg.nodeId} "${cfg.name}": ONLINE (probe: a socket to ${cfg.serverUrl} opened)`
            : `node ${cfg.nodeId} "${cfg.name}": OFFLINE (probe: no socket to ${cfg.serverUrl} within 5 s)`;
        } else {
          // Same correction as enroll's closing line: the remedy an operator
          // wants is the one that survives them closing the terminal, so the
          // service verbs come first and `run` is named as the foreground
          // alternative rather than as the only answer.
          line =
            `node ${cfg.nodeId} "${cfg.name}": OFFLINE (no local subshell running; ` +
            `start it with \`subshell service start\` — or \`subshell service install\` if no ` +
            `service is installed yet — or run \`subshell run\` in the foreground. ` +
            `Pass --probe to ask the control plane instead; a probe KICKS a remote agent!)`;
        }
        if (parsed.flags.json) {
          // The update transaction's state, for the same reason `paths` is
          // here: a caller (the desktop app, a script, a person mid-incident)
          // should read what THIS binary knows rather than derive it. A
          // `pending` marker under a running agent means a swap happened and
          // the plane has not yet accepted or refused it; `lastFailure` is the
          // rollback that already happened, and it survives until the next
          // update so the reason is still on screen an hour later.
          const pending = await readMarker(pendingMarkerPath(cfg.dataDir));
          const lastFailure = await readMarker<UpdateFailure>(failedMarkerPath(cfg.dataDir));
          // Resolved through the SAME ladder `update` uses — the installed
          // service definition first, this process only when no definition
          // names one. Reporting `process.execPath` here (which this did until
          // 2026-09-15) could name one file while an update replaced another,
          // on exactly the hosts where that distinction is the whole problem.
          // A refusal — a source checkout, a definition naming an interpreter
          // and a script — has no single binary to name: null, not a guess.
          // Through the CLI's OWN service seam (`RunDeps.service`), not this
          // module's defaults: the unit/plist paths hang off the real
          // `homedir()`, so a suite reading them would answer from whatever
          // the developer happens to have enrolled on their laptop. Every
          // other reader of a service definition here is injected the same
          // way, for the same reason.
          const sd = deps.service ?? DEFAULT_DEPS(configExists);
          const installed = await resolveNodeBinaryPath({
            platform: sd.platform,
            home: sd.home,
            // `configDir` and `fileExists` are injected for the SAME reason as
            // the four above, and they became load-bearing when the darwin
            // resolution learned about `--no-autostart`: without them this
            // falls back to `clientHome()` and a real `access()`, so a suite
            // that injected `home` would still stat the developer's own
            // `~/.config/subshell/dev.subshell.client.plist`. Production is
            // unaffected — `DEFAULT_DEPS` supplies exactly those fallbacks —
            // which is precisely why the hole would have stayed invisible.
            configDir: sd.configDir,
            fileExists: sd.fileExists,
            readFile: sd.readFile,
            runCmd: sd.runCmd,
          }).catch(() => null);
          const body = {
            nodeId: cfg.nodeId,
            serverUrl: cfg.serverUrl,
            online,
            agentVersion: NODE_VERSION,
            // Which rung named `paths.binary`, so "the unit says so" is
            // legible from "this is me". NOT inside `paths`: it is not a path,
            // and that object's key set is pinned as the reset's deletion set.
            binarySource: installed?.source ?? null,
            ...(daemonAgeMs !== undefined ? { daemonAgeMs } : {}),
            ...(probe !== undefined ? { probe } : {}),
            // What a reset deletes, named by the CLI rather than guessed by a caller
            // (the server-reset rule, spec §5.1) — a property of the loaded config,
            // not of liveness, so it is present here whether `online` is true or not.
            paths: {
              configFile: configPath(),
              lockFile: lockPath(),
              dataDir: cfg.dataDir,
              /** The file `update` replaces — see `installed` above. */
              binary: installed?.binary ?? null,
              /**
               * The agent's OWN capped log (`log-file.ts`) — the file the
               * plane's log view shows, so a desktop that reveals a log and a
               * browser that reads one cannot be looking at two different
               * ones. It is NOT the service manager's redirect, which
               * `service status --json` reports as `logPath` and which a
               * person debugging a service definition wants instead.
               *
               * NOT a deletion target, like `binary` beside it: the desktop
               * reset names `configFile`, `lockFile` and `dataDir`
               * individually (`apps/client/desktop/src-tauri/src/reset.rs`),
               * and the log is deliberately left behind — it is the record of
               * the reset itself, holds no credential, and is bounded at
               * 200 KB whatever happens to it. That the block is read key by
               * key rather than swept is what makes this safe to add, and a
               * test on each side pins it.
               */
              agentLog: agentLogPath(),
            },
            update: { pending, lastFailure },
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
