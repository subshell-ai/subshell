import { readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { confirm as clackConfirm, text as clackText, intro, isCancel, outro } from "@clack/prompts";
import { runReport, runSubshellMcp } from "@internal/mcp-core";
import { appendStdinToLogFile } from "@internal/pane-runtime";
import { licenseNotice } from "@internal/subshell-protocol";
import { runBackup } from "@/commands/backup.js";
import { type ConfigureOpts, runConfigure } from "@/commands/configure.js";
import { type InitDeps, runInit, setupHandoffLines } from "@/commands/init.js";
import { collectStatus, runStatus, serviceStateLines, syncPortListening } from "@/commands/status.js";
import { runUpdate, type UpdateOpts } from "@/commands/update.js";
import { serverConfigDir } from "@/config-env.js";
import {
  type CliResult,
  controlService,
  DEFAULT_DEPS,
  installService,
  queryService,
  SERVICE_VERBS,
  type ServiceDeps,
  setAutostart,
  uninstallService,
} from "@/service.js";
import type { McpResolveIo } from "@/services/mcp-resolve.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * Hand-rolled subcommand dispatch for the `subshell-server` binary
 * (client `cli.ts` precedent — no flag library). The rule that keeps the
 * no-subcommand systemd boot contract byte-identical: `dispatchCli` returns FALSE
 * for anything that is not a known subcommand (no args, or a leading flag),
 * and the caller falls through to booting the server.
 *
 * The safety story in two load-bearing invariants (this header is their
 * canonical home — other files point here instead of restating it), plus one
 * convention:
 *
 * 1. `dispatchCli` sets the engaged flag SYNCHRONOUSLY, before its first
 *    possible await, and `index.ts` gates its boot body on it. This is what
 *    keeps ANY command — quick or long-running — from booting the server
 *    underneath it. It carries the load that sync-exit used to (see the
 *    convention below), and it is what makes `mcp` legal: `mcp` is
 *    long-running BY CONTRACT (spec 2026-09-03), parking in its stdio loop
 *    while the entry body sits gated.
 * 2. The entry graph is INERT AT IMPORT, by contract and under test:
 *    evaluating it opens no database, binds no port, and writes nothing —
 *    pinned subprocess-side by `__tests__/cli-entry.test.ts` (real argv,
 *    fresh CWD, port sentinel, sqlite-litter sweep) and
 *    `__tests__/auth-import-purity.test.ts`. "Inert" means side-EFFECT-free;
 *    the prelude's config.env read and the dotenvx `.env` layer are inputs,
 *    not litter. Lazy singletons (`getAuth()`, the default local launcher)
 *    are the mechanism; historical note: the eager better-auth build opened
 *    SQLite at import and littered async commands' CWDs — the purity tests
 *    are why it can never come back.
 *
 * Convention (not a safety mechanism): handled quick commands run to
 * completion and `process.exit` SYNCHRONOUSLY inside `dispatchCli` (sync fs,
 * `readSync(0, …)` prompts, `Bun.spawnSync` for the service manager). Four
 * commands opt out by name: `mcp` (long-running by contract), `init` and
 * `configure` (clack prompts), and `update`/`backup` (spec 2026-09-15 — they
 * download, prompt, and snapshot a database). It is
 * kept because suspension is otherwise invisible on bun 1.4.0 — measured, NOT
 * spec behaviour: any top-level await in the entry prelude lets Bun evaluate
 * the rest of the graph and the entry body while the await is pending
 * (inert per 2, gated per 1 — but still noise). `mcp` opts out deliberately.
 */

/** Injectable stdio/exit/IO seams so tests can pin output without subprocesses. */
export interface CliDeps {
  /** stdout writer for command output (default: `console.log`). */
  log?: (line: string) => void;
  /** stderr writer for usage/errors (default: `console.error`). */
  error?: (line: string) => void;
  /**
   * Interactive prompt for the five `init`/`configure` questions (default:
   * {@link promptText} — `@clack/prompts`'s `text`). Returns the raw answer,
   * or null on a cancel/EOF.
   */
  prompt?: (question: string, def: string) => string | null | Promise<string | null>;
  /**
   * Yes/no question (default: {@link promptConfirm} — `@clack/prompts`'s
   * `confirm`). Today only `init`'s service question asks one.
   */
  confirm?: (question: string, def: boolean) => boolean | null | Promise<boolean | null>;
  /**
   * The tmux offer's prompt (default: {@link promptLineSync}). A SECOND text
   * seam because `tmuxPreflight` is shared with `installService`, which is
   * synchronous end to end and therefore cannot await an answer — see
   * `CommandDeps.promptSync`.
   */
  promptSync?: (question: string, def: string) => string | null;
  /**
   * Installs the background service for `init`'s own service question
   * (default: the same `installService` the `service install` verb calls,
   * with autostart armed). Injected by tests so an `init` run never writes a
   * real unit or plist.
   */
  installService?: () => CliResult;
  /** This host's name for the handoff's LAN line (default: `os.hostname()`). */
  hostname?: () => string;
  /** Process exit, injectable so tests observe codes (default: `process.exit`). */
  exit?: (code: number) => void;
  /**
   * Synchronous port-liveness probe for `status` (default: {@link syncPortListening}).
   * Returns true/false, or null when the platform offers no probe at all.
   */
  probePort?: (host: string, port: number) => boolean | null;
  /**
   * Config home for `init`/`configure` (default: `serverConfigDir()`).
   * Injectable so the suites write to a temp dir, never `~/.config`.
   */
  configDir?: string;
  /** Env source for the command flows (default: `process.env`). */
  env?: Record<string, string | undefined>;
  /** Executable lookup for the tmux preflight (default: `Bun.which`). */
  which?: (name: string) => string | null;
  /**
   * PATH/executable seams for the `status` mcp-entrypoint probe
   * (`which`/`execPath`/`argv1`; default: the real ones — see
   * `probeMcpLaunch` in mcp-resolve.ts). Injectable so tests pin the rung
   * without touching a real PATH or process identity.
   */
  mcpIo?: McpResolveIo;
  /**
   * stdio MCP server runner for the `mcp` subcommand (default:
   * `runSubshellMcp` from `@internal/mcp-core`). Injectable so tests pin the
   * dispatch wiring without opening a real stdio loop.
   */
  mcpRun?: () => Promise<void>;
  /**
   * Harness-hook reporter for the `report` subcommand (default: `runReport`
   * from `@internal/mcp-core`). Injectable so tests pin the dispatch wiring
   * without a transport.
   */
  reportRun?: (argv: string[]) => Promise<void>;
  /** Interactive-TTY signal for the command flows (default: `process.stdin.isTTY`). */
  isTTY?: boolean;
  /** Runtime platform for `service`/`status` (default: `process.platform`). */
  platform?: NodeJS.Platform;
  /** Home the unit/plist hang off (default: `homedir()`); tests inject a temp dir. */
  home?: string;
  /** Numeric uid for the launchd `gui/<uid>` domain (default: `process.getuid?.() ?? 0`). */
  uid?: number;
  /** Executable `service install` bakes into the unit/plist (default: `process.execPath`). */
  servicePath?: string;
  /** Script path for the dev-form exec line (default: `process.argv[1] ?? ""`). */
  argv1?: string;
  /** PATH baked into the unit/plist (default: `process.env.PATH`). */
  pathEnv?: string;
  /** Synchronous service-manager command runner (default: the `Bun.spawnSync` wrapper). */
  runCmd?: (cmd: string[]) => { code: number; out: string; err: string };
  /**
   * Sync package-manager runner for the tmux offer (default: `spawnInherit`
   * — inherited stdio). Injectable so a `dispatchCli` suite can pin the
   * offer→CONTINUES wiring without invoking a real installer.
   */
  spawnInstall?: (argv: readonly string[]) => number;
}

const USAGE = `subshell-server: the Subshell control plane

usage:
  subshell-server                run the server (boot path: no subcommand)
  subshell-server version        print the version and exit
  subshell-server license        print the copyright and licence and exit
  subshell-server status         print the resolved config view and exit (--json for machine output)
  subshell-server init           first run: config home + auth secret + config.env + the service
  subshell-server configure      (re)write config.env; interactive unless --yes
  subshell-server update         install a newer server over this one (--check to look only)
  subshell-server backup         snapshot the database now (--json for machine output)
  subshell-server service install    background the server (systemd user unit / launchd agent);
                                     --no-autostart to run it now but not at login
  subshell-server service uninstall  stop it and remove the service definition
  subshell-server service enable     start it at login (does not touch the running process)
  subshell-server service disable    stop starting it at login (does not touch the running process)
  subshell-server service status     what the service manager reports (--json for machine output)
  subshell-server service start      start the installed service
  subshell-server service stop       stop it (the definition stays installed)
  subshell-server service restart    restart it (--force to override the live-pane refusal)
  subshell-server mcp                serve the pane-spawned stdio MCP server (spawned by harnesses)
  subshell-server report attention turn_complete|needs_attention
  subshell-server report session     report a pane's state (run by harness hooks, not by hand)
  subshell-server pane-log --file <path>
                                     append stdin to a pane log, flushing each
                                     read (run by tmux's own pipe-pane, not by hand)

init/configure flags: --port <n> --host <h> --base-url <url> --db-path <path> --yes
                      --trusted-origins <origin,origin>   other addresses browsers will
                                                          use (empty clears the list)
init-only flags:      --service / --no-service            install the background service,
                                                          or skip it (default: install)

update flags:         --check                  report what is available and stop
                      --to <version>           install this published version
                      --from <file>            install a local file (no digest to check)
                      --force                  allow a downgrade, and override the pane refusal
                      --yes                    skip the confirmation
                      --json                   machine-readable output
                      --no-restart             swap the binary; the caller restarts
                      --rollback               undo the last update (binary + database)

config precedence: process env > config.env > .env > built-in defaults
`;

/**
 * Set synchronously the moment a recognised (or unknown-word) subcommand is
 * seen — i.e. whenever `dispatchCli` will NOT return false — so `index.ts`
 * can skip its boot body even if a future handler suspends mid-command.
 * Module state: one process, one dispatch; tests call the function directly
 * and never import the entry.
 */
let cliEngaged = false;

/** True once {@link dispatchCli} has recognised a CLI invocation (see invariant 2). */
export function isCliEngaged(): boolean {
  return cliEngaged;
}

/**
 * Runs the CLI dispatch for one invocation.
 *
 * @param argv - `process.argv.slice(2)` — the args after the executable
 * @param deps - stdio/exit injection seams (tests); real runs use the defaults
 * @returns Promise of "handled" — true when the command owns the process.
 *   With default `deps` a handled command has already `process.exit`ed by
 *   the time this resolves (invariant 1); the boolean is the TEST seam.
 *   The one exception is `mcp`'s success path: handled-but-never-settling —
 *   the process lives on with the stdio transport (see the case comment).
 */
export async function dispatchCli(argv: string[], deps: CliDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const [command] = argv;
  // Boot path: no subcommand, or a leading flag (a service manager passes
  // flags and env, never a subcommand word). The boot graph continues untouched.
  if (!command || command.startsWith("-")) return false;
  cliEngaged = true;

  switch (command) {
    case "version":
      log(`subshell-server ${SERVER_VERSION}`);
      exit(0);
      return true;
    // Separate from `version` on purpose: `version` is a machine contract —
    // the release smoke compares its output for EXACT equality — and this
    // binary ships as a bare single file with no LICENSE beside it, so this
    // subcommand is how a recipient gets the terms both licences oblige us to
    // hand over. `licenseNotice` already ends in a newline, so it is written
    // with the trailing blank line trimmed to keep `log`'s one-line-per-call
    // shape.
    case "license":
      log(licenseNotice("subshell-server", SERVER_VERSION).trimEnd());
      exit(0);
      return true;
    case "status": {
      // Flags are validated (unlike the pre-2026-09-05 behaviour of silently
      // ignoring extras): a typo'd `--jsonn` that fell through to human text
      // would hand a script prose it cannot parse. The exit code stays 0 for
      // every VALID invocation — status reflects state, it does not judge it.
      const bad = argv.slice(1).find((f) => f !== "--json");
      if (bad !== undefined) {
        error(`subshell-server: unexpected argument '${bad}'`);
        error(USAGE);
        exit(1);
        return true;
      }
      if (argv.includes("--json")) log(JSON.stringify(collectStatus(deps), null, 2));
      else runStatus(log, deps);
      exit(0);
      return true;
    }
    // Out-of-band reporting from a harness hook (`report attention <kind>`,
    // `report session`). Spawned by hooks, never typed by humans — which is
    // why it can only ever exit 0: a hook's exit code and stderr land in the
    // user's session, and the reports themselves are fire-and-forget (a lost
    // one costs a notification, never a turn). `runReport` swallows its own
    // failures; the catch here is for anything an injected runner throws.
    case "report":
      try {
        await (deps.reportRun ?? runReport)(argv.slice(1));
      } catch {
        // Deliberately silent — see above.
      }
      exit(0);
      return true;
    // The tmux pipe-pane capture child for `local` panes (built by
    // TmuxRunner.pipePane on this host, never typed): append our stdin — the
    // pane's output — to --file, flushing EVERY read. It exists because `cat`
    // on some hosts (uutils coreutils) buffers a partial write to a regular
    // file and freezes the browser's live view until an Enter-sized burst
    // flushes it; this is the unbuffered read/write copy that GNU/BSD cat
    // already do. A pre-boot verb like `report`/`mcp`: no DB, no boot. It
    // blocks until stdin reaches EOF (the pane died or the pipe was re-armed),
    // so a retired capture never leaks a child.
    case "pane-log": {
      // Exact argv, parsed by position rather than searched: pipePane emits
      // exactly `pane-log --file <absolute path>`, so anything else — a bare
      // positional, a stray flag, `--file --force` (indexOf would happily take
      // the flag as the path) — is a usage error, not a file to open. A
      // RELATIVE path is refused too: the caller always names an absolute path
      // under the data dir, so a relative one means argv was assembled wrong,
      // and appending to a cwd-dependent guess is worse than refusing. (The
      // node CLI's `pane-log` applies the same rule through its flag parser.)
      const rest = argv.slice(1);
      const file = rest.length === 2 && rest[0] === "--file" ? rest[1] : undefined;
      if (file === undefined || file === "" || !file.startsWith("/")) {
        error("subshell-server: pane-log requires --file <absolute path>");
        exit(1);
        return true;
      }
      try {
        appendStdinToLogFile(file);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        error(`subshell-server: pane-log: ${detail}`);
        exit(1);
        return true;
      }
      exit(0);
      return true;
    }
    // The pane-spawned MCP stdio server (spec 2026-09-03): the ONLY
    // long-running command — legal because the graph evaluates IO-free (lazy
    // getAuth) and `isCliEngaged()` (set above, synchronously) keeps the boot
    // body from running in the suspension window.
    case "mcp":
      try {
        await (deps.mcpRun ?? runSubshellMcp)();
      } catch (err: unknown) {
        // A rejected runner goes to stderr + exit 1 HERE — index.ts's global
        // unhandledRejection handler (FATAL log + exit 1) must never see it.
        // MESSAGE-first, not stack-first: measured on bun 1.4.0, the
        // COMPILED bundle's `err.stack` header line omits the message
        // ("Error\n  at …") while `err.message` is intact, and the contract
        // refusal text is the actionable half for whoever spawned the pane.
        const detail =
          err instanceof Error ? (err.message !== "" ? err.message : (err.stack ?? String(err))) : String(err);
        error(`subshell mcp: fatal: ${detail}`);
        exit(1);
        return true;
      }
      // ATTACH is not done. `runSubshellMcp` resolves once the stdio
      // transport CONNECTS (mcp-core's contract — the same one apps/node/agent's
      // T18 fix documents); an `exit(0)` here — or even returning `true`,
      // which cli-bootstrap's `.then(handled ⇒ exit 0)` would act on —
      // kills the live transport milliseconds after `ready`. This is the
      // server twin of apps/node/agent's keepAlive: PARK the dispatch promise so
      // nothing downstream can exit, and let the transport's stdin listener
      // own the process lifetime. When the pane's client disconnects, the
      // stream ends, the drained event loop ends the process (0) naturally,
      // and this promise never settles.
      return new Promise<boolean>(() => {});
    case "init":
    case "configure": {
      // `--service`/`--no-service` belong to `init` alone: `configure` never
      // installs anything, so accepting them there would be a flag that
      // silently does nothing.
      const opts = parseConfigFlags(argv.slice(1), error, { allowService: command === "init" });
      if (!opts) {
        error(USAGE);
        exit(1);
        return true;
      }
      const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
      const cmdDeps: InitDeps = {
        prompt: deps.prompt ?? promptText,
        confirm: deps.confirm ?? promptConfirm,
        promptSync: deps.promptSync ?? promptLineSync,
        log,
        error,
        configDir: deps.configDir ?? serverConfigDir(),
        env: deps.env ?? process.env,
        which: deps.which ?? ((name) => Bun.which(name) ?? null),
        isTTY,
        // tmux offer seams (spec 2026-09-03): platform drives installer
        // detection AND the hint text; spawnInstall stays injectable.
        platform: deps.platform ?? process.platform,
        spawnInstall: deps.spawnInstall,
        // The SAME function the `service install` verb calls, with autostart
        // armed (spec 2026-09-15 §4.1) — one installer, so `init` and
        // `service install` cannot put different definitions on a host.
        installService: deps.installService ?? (() => installService(serviceDeps(deps, log), { autostart: true })),
        hostname: deps.hostname,
      };
      // The clack frame belongs to the clack prompts: a caller that injects
      // its own `prompt` (every test) is not drawing one, and would otherwise
      // emit bars onto a real stdout from inside a unit test. `--yes` and a
      // non-TTY draw nothing either — those runs print nothing but results.
      const framed = !opts.yes && isTTY && deps.prompt === undefined;
      if (framed) intro(`subshell-server ${SERVER_VERSION}`);
      // Async since the prompt became one (spec 2026-09-15 §3.2). Safe for
      // the same reason `mcp` is: the graph is IO-free at import and
      // `cliEngaged` was set synchronously above, so no boot can start
      // underneath a command that is waiting for an answer.
      const code = command === "init" ? await runInit(opts, cmdDeps) : await runConfigure(opts, cmdDeps);
      if (framed) outro(code === 0 ? "Done." : "Stopped.");
      exit(code);
      return true;
    }
    // ASYNC, like `init` and `configure` — the third named exception to the
    // sync-exit convention (see this file's header and AGENTS.md). It
    // downloads and it prompts; neither is possible with `readSync(0, …)`.
    case "update": {
      const opts = parseUpdateFlags(argv.slice(1), error);
      if (!opts) {
        error(USAGE);
        exit(1);
        return true;
      }
      const code = await runUpdate(opts, {
        log,
        error,
        confirm: deps.confirm ?? promptConfirm,
        isTTY: deps.isTTY ?? process.stdin.isTTY === true,
        service: serviceDeps(deps, log),
      });
      exit(code);
      return true;
    }
    case "backup": {
      const bad = argv.slice(1).find((f) => f !== "--json");
      if (bad !== undefined) {
        error(`subshell-server: unexpected argument '${bad}'`);
        error(USAGE);
        exit(1);
        return true;
      }
      const code = await runBackup({ json: argv.includes("--json") }, { log, error });
      exit(code);
      return true;
    }
    case "service": {
      // `service <verb> [flags]` (client cli.ts UX: an unknown verb is a
      // usage error). Flags are per-verb and deliberately few — `--force`
      // exists only to override the restart refusal, `--json` only where
      // there is structured state worth emitting.
      const verb = argv[1];
      if (verb === undefined || !isServiceCommand(verb)) {
        error(
          verb === undefined
            ? `subshell-server: service requires one of ${SERVICE_COMMANDS.join(", ")}`
            : `subshell-server: unknown service command '${verb}'`,
        );
        error(USAGE);
        exit(1);
        return true;
      }
      const allowed = SERVICE_FLAGS[verb] ?? NO_FLAGS;
      const flags = argv.slice(2);
      const bad = flags.find((f) => !allowed.has(f));
      if (bad !== undefined) {
        error(`subshell-server: unexpected argument '${bad}'`);
        error(USAGE);
        exit(1);
        return true;
      }
      const sdeps = serviceDeps(deps, log);

      // `status` is a VIEW, not a command: it always exits 0 (same rule as
      // top-level `status`) so a script can read state without branching on
      // an exit code that would also mean "the call itself failed".
      if (verb === "status") {
        const state = queryService(sdeps);
        if (flags.includes("--json")) log(JSON.stringify(state, null, 2));
        else for (const line of serviceStateLines(state)) log(line);
        exit(0);
        return true;
      }

      // `verb` narrows to a ServiceVerb by exclusion here: `status` returned
      // above, and the two authoring verbs are handled first — so a new member
      // of SERVICE_COMMANDS that nothing handles is a compile error, not a
      // silent fall into controlService.
      const result =
        verb === "install"
          ? installService(sdeps, { autostart: !flags.includes("--no-autostart") })
          : verb === "uninstall"
            ? uninstallService(sdeps)
            : verb === "enable" || verb === "disable"
              ? setAutostart(sdeps, verb === "enable")
              : controlService(sdeps, verb, { force: flags.includes("--force") });
      // out/err arrive pre-newline-terminated; log/error append their own.
      if (result.out !== "") log(result.out.replace(/\n+$/, ""));
      if (result.err !== "") error(result.err.replace(/\n+$/, ""));
      // `init` and `service install` are the two commands a person ends on,
      // so both say where to create the admin account — from ONE helper, or
      // the two sentences drift and one of them starts naming a dead address.
      if (verb === "install" && result.code === 0) {
        for (const line of setupHandoffLines({ configDir: sdeps.configDir, hostname: deps.hostname })) log(line);
      }
      exit(result.code);
      return true;
    }
    default:
      error(`subshell-server: unknown command '${command}'`);
      error(USAGE);
      exit(1);
      return true;
  }
}

/**
 * Assemble the `service.ts` deps from the CLI's seams.
 *
 * Shared by the `service` verbs and by `init`'s own service question, so both
 * install through one seed — a second assembly here is how `init` would come
 * to bake a different ExecStart or PATH than `service install` does.
 *
 * Sync end to end: DEFAULT_DEPS runs manager commands via `Bun.spawnSync` and
 * writes the unit/plist with sync fs, which is what lets `installService`
 * stay a plain function (and why the tmux offer needs its own sync prompt).
 */
function serviceDeps(deps: CliDeps, log: (line: string) => void): ServiceDeps {
  const sdeps = DEFAULT_DEPS({
    platform: deps.platform ?? process.platform,
    home: deps.home ?? homedir(),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    servicePath: deps.servicePath ?? process.execPath,
    argv1: deps.argv1 ?? process.argv[1] ?? "",
    configDir: deps.configDir ?? serverConfigDir(),
    env: deps.env ?? process.env,
    which: deps.which ?? ((name) => Bun.which(name) ?? null),
    pathEnv: deps.pathEnv ?? process.env.PATH,
    // tmux offer (spec 2026-09-03): service install takes no flags, so the
    // gate is TTY-only — non-interactive installs keep the refusal. Platform
    // rides on the seed itself (ServiceDeps.platform) where the preflight
    // reads it for both detection and the hint.
    tmuxOffer: {
      interactive: deps.isTTY ?? process.stdin.isTTY === true,
      log,
      prompt: deps.promptSync ?? promptLineSync,
      spawn: deps.spawnInstall,
    },
  });
  if (deps.runCmd) sdeps.runCmd = deps.runCmd;
  return sdeps;
}

/**
 * Every word `service` accepts: the two authoring verbs, the read-only view,
 * the two autostart verbs, and the control verbs — the last spread from `service.ts` so a new verb
 * there cannot be silently unreachable here.
 */
const SERVICE_COMMANDS = ["install", "uninstall", "status", "enable", "disable", ...SERVICE_VERBS] as const;
type ServiceCommand = (typeof SERVICE_COMMANDS)[number];
const isServiceCommand = (word: string): word is ServiceCommand =>
  (SERVICE_COMMANDS as readonly string[]).includes(word);

/** Per-verb flag allowlist — anything else is the same "unexpected argument" refusal the config flags use. */
const SERVICE_FLAGS: Partial<Record<ServiceCommand, ReadonlySet<string>>> = {
  status: new Set(["--json"]),
  restart: new Set(["--force"]),
  install: new Set(["--no-autostart"]),
};

/** Shared empty allowlist for the verbs that take no flags at all. */
const NO_FLAGS: ReadonlySet<string> = new Set();

/** `update`'s boolean flags, and what each one sets. */
const UPDATE_BOOLEANS: Record<string, (o: UpdateOpts) => void> = {
  "--check": (o) => {
    o.check = true;
  },
  "--force": (o) => {
    o.force = true;
  },
  "--yes": (o) => {
    o.yes = true;
  },
  "--json": (o) => {
    o.json = true;
  },
  "--no-restart": (o) => {
    o.noRestart = true;
  },
  "--rollback": (o) => {
    o.rollback = true;
  },
};

/** `update`'s value-taking flags. */
const UPDATE_VALUE_FLAGS = new Set(["--to", "--from"]);

/**
 * Hand-rolled `update` flag parser, the same shape
 * {@link parseConfigFlags} has: the `--flag=value` form alongside the
 * separate-token one, an empty value refused, a stray positional refused.
 *
 * `--rollback` is checked against the install-only flags HERE rather than
 * inside the command, because "rollback --to 0.7.0" is a person describing an
 * act this verb does not have, and the earliest possible refusal is the kind
 * one.
 *
 * @param rest - the args after the subcommand word
 * @param error - stderr sink for the one refusal line
 * @returns the parsed options, or null after writing the error line
 */
export function parseUpdateFlags(rest: string[], error: (line: string) => void): UpdateOpts | null {
  const opts: UpdateOpts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const boolean = UPDATE_BOOLEANS[flag];
    if (boolean !== undefined) {
      if (inline !== undefined) {
        error(`subshell-server: flag '${flag}' takes no value`);
        return null;
      }
      boolean(opts);
      continue;
    }
    if (!token.startsWith("-")) {
      error(`subshell-server: unexpected argument '${token}'`);
      return null;
    }
    if (!UPDATE_VALUE_FLAGS.has(flag)) {
      error(`subshell-server: unknown flag '${flag}'`);
      return null;
    }
    const value = inline ?? rest[i + 1];
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
      error(`subshell-server: flag '${flag}' requires a value`);
      return null;
    }
    if (inline === undefined) i++;
    if (flag === "--to") opts.to = value;
    else opts.from = value;
  }
  if (opts.to !== undefined && opts.from !== undefined) {
    error("subshell-server: --to and --from name two different things to install; pass one");
    return null;
  }
  if (opts.rollback === true) {
    const conflicting = (["check", "to", "from", "noRestart"] as const).filter((k) => opts[k] !== undefined);
    if (conflicting.length > 0) {
      error("subshell-server: --rollback takes only --yes, --force and --json");
      return null;
    }
  }
  return opts;
}

/** Value-taking flags of `init`/`configure` (client `cli.ts` pattern — no flag library). */
const CONFIG_VALUE_FLAGS = new Set(["--port", "--host", "--base-url", "--db-path", "--trusted-origins"]);

/**
 * Value flags whose EMPTY value is a real answer rather than a typo.
 *
 * Only `--trusted-origins`: an empty origin list means "no extras", and since
 * `configure` now defaults every key to its stored value, passing empty is the
 * only way a non-interactive caller can CLEAR a configured list. An empty
 * port, host, base URL or db path stays the refusal it always was.
 */
const CONFIG_EMPTYABLE_FLAGS = new Set(["--trusted-origins"]);

/**
 * Hand-rolled `init`/`configure` flag parser: `--port <n> --host <h>
 * --base-url <u> --trusted-origins <o,o> --db-path <p> --yes`, with the
 * `--flag=value` form accepted alongside (split on the FIRST `=`, so values
 * may contain `=`). Raw strings — range/URL validation is the command's job
 * (its messages are unit-tested); this layer only owns shape: unknown flag,
 * stray positional, missing value, and `--yes` with a value all mean "usage +
 * exit 1".
 *
 * An EMPTY value is a usage error too, EXCEPT for the flags in
 * {@link CONFIG_EMPTYABLE_FLAGS} — today just `--trusted-origins`, where an
 * empty list is a real answer and the only way to clear a stored one. A value
 * shadowed by the next flag (`--trusted-origins --yes`) stays an error either
 * way.
 *
 * `--service`/`--no-service` are boolean and `init`-only; `configure`
 * installs nothing, so there they are an unknown flag rather than a no-op
 * silently accepted.
 *
 * @param rest - the args after the subcommand word
 * @param error - stderr sink for the one refusal line
 * @param opts0 - `allowService` enables the two boolean service flags (`init`)
 * @returns the parsed options, or null after writing the error line
 */
function parseConfigFlags(
  rest: string[],
  error: (line: string) => void,
  opts0: { allowService: boolean } = { allowService: false },
): ConfigureOpts | null {
  const opts: ConfigureOpts = {};
  /** The boolean flags this invocation accepts, and what each one means. */
  const booleans: Record<string, (o: ConfigureOpts) => void> = {
    "--yes": (o) => {
      o.yes = true;
    },
    ...(opts0.allowService
      ? {
          "--service": (o: ConfigureOpts) => {
            o.service = true;
          },
          "--no-service": (o: ConfigureOpts) => {
            o.service = false;
          },
        }
      : {}),
  };
  const takeValue = (flag: string, inline: string | undefined, next: string | undefined): string | null => {
    const value = inline ?? next;
    // A MISSING value, or one shadowed by the next flag, is always an error.
    // An EMPTY one is an error except for the flags that accept it.
    const emptyIsAnswer = CONFIG_EMPTYABLE_FLAGS.has(flag);
    if (value === undefined || (inline === undefined && value.startsWith("--")) || (value === "" && !emptyIsAnswer)) {
      error(`subshell-server: flag '${flag}' requires a value`);
      return null;
    }
    return value;
  };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const boolean = booleans[flag];
    if (boolean !== undefined) {
      if (inline !== undefined) {
        error(`subshell-server: flag '${flag}' takes no value`);
        return null;
      }
      boolean(opts);
      continue;
    }
    if (!token.startsWith("-")) {
      error(`subshell-server: unexpected argument '${token}'`);
      return null;
    }
    if (!CONFIG_VALUE_FLAGS.has(flag)) {
      error(`subshell-server: unknown flag '${flag}'`);
      return null;
    }
    const value = takeValue(flag, inline, rest[i + 1]);
    if (value === null) return null;
    if (inline === undefined) i++; // consumed the separate-token value
    switch (flag) {
      case "--port":
        opts.port = value;
        break;
      case "--host":
        opts.host = value;
        break;
      case "--base-url":
        opts.baseUrl = value;
        break;
      case "--db-path":
        opts.dbPath = value;
        break;
      case "--trusted-origins":
        opts.trustedOrigins = value;
        break;
    }
  }
  return opts;
}

/** Decode a line's worth of bytes collected one at a time from stdin. */
const decodeLine = (bytes: number[]): string => Buffer.from(bytes).toString("utf8").replace(/\r$/, "");

/**
 * The tmux offer's prompt: `writeSync(1, …)` + one-byte blocking
 * `readSync(0, …)` until LF. It stays SYNCHRONOUS — and stays here beside the
 * clack ones rather than being replaced by them — because `tmuxPreflight` is
 * shared with `installService`, which returns a `CliResult` rather than a
 * promise and cannot await an answer. A
 * canonical-mode TTY delivers whole lines, so byte-at-a-time reads simply
 * block on the tty driver; multi-byte UTF-8 reassembles at decode. EOF
 * (Ctrl-D, or a closed stdin) returns null so the caller aborts with zero
 * writes. EAGAIN (a non-blocking stdin under some launcher) parks briefly
 * and retries rather than fabricating an answer.
 */
/**
 * The production text prompt: `@clack/prompts`'s `text`, with the default
 * shown as a placeholder AND returned for an empty answer, so pressing ENTER
 * keeps what is configured (which is what "defaults follow the file" means).
 *
 * It replaced a one-line `readSync(0, …)` because that could render neither a
 * default, a validation error, nor a cancel — and the first real branch a
 * headless operator meets deserves the same affordance the desktop
 * assistant's radio buttons give (spec 2026-09-15 §3.2).
 *
 * @returns the answer, or null when the person cancelled (Ctrl-C)
 */
export async function promptText(question: string, def: string): Promise<string | null> {
  const answer = await clackText({ message: question, placeholder: def, defaultValue: def });
  return isCancel(answer) ? null : answer;
}

/**
 * The production yes/no prompt: `@clack/prompts`'s `confirm`, with `def`
 * pre-selected so ENTER is the default answer.
 *
 * @returns the choice, or null when the person cancelled (Ctrl-C)
 */
export async function promptConfirm(question: string, def: boolean): Promise<boolean | null> {
  const answer = await clackConfirm({ message: question, initialValue: def });
  return isCancel(answer) ? null : answer;
}

export function promptLineSync(question: string, def: string): string | null {
  writeSync(1, `${question} [${def}]: `);
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, one, 0, 1, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Bun.sleepSync(5);
        continue;
      }
      if (code === "EIO") return null; // hangup on the far end — treat as closed stdin
      throw err;
    }
    if (n === 0) return bytes.length > 0 ? decodeLine(bytes) : null;
    if (one[0] === 0x0a) return decodeLine(bytes);
    bytes.push(one[0] as number);
  }
}
