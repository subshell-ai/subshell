import { existsSync, readFileSync, readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { runSubshellMcp } from "@internal/mcp-core";
import { DEFAULT_DATABASE_PATH } from "@internal/subshell-protocol";
import { type CommandDeps, type ConfigureOpts, runConfigure } from "@/commands/configure.js";
import { runInit } from "@/commands/init.js";
import { resolveConfig, serverConfigDir } from "@/config-env.js";
import { DEFAULT_DEPS, installService, serviceArtifactPath, uninstallService } from "@/service.js";
import { type McpResolveIo, probeMcpLaunch } from "@/services/mcp-resolve.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * Hand-rolled subcommand dispatch for the `subshell-server` binary
 * (client `cli.ts` precedent — no flag library). The rule that keeps the
 * svc.sh/systemd boot contract byte-identical: `dispatchCli` returns FALSE
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
 * `readSync(0, …)` prompts, `Bun.spawnSync` for the service manager). It is
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
   * Interactive prompt for `init`/`configure` (default: {@link promptLineSync}
   * — sync `readSync(0, …)`, honoring cli.ts invariant 1). Returns the raw
   * answer or null on EOF.
   */
  prompt?: (question: string, def: string) => string | null;
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
}

const USAGE = `subshell-server — the Subshell control plane

usage:
  subshell-server                run the server (boot path: no subcommand)
  subshell-server version        print the version and exit
  subshell-server status         print the resolved config view and exit
  subshell-server init           first run: config home + auth secret + config.env
  subshell-server configure      (re)write config.env; interactive unless --yes
  subshell-server service install    background the server (systemd user unit / launchd agent)
  subshell-server service uninstall  stop it and remove the service definition
  subshell-server mcp                serve the pane-spawned stdio MCP server (spawned by harnesses)

init/configure flags: --port <n> --host <h> --base-url <url> --db-path <path> --yes

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
  // Boot path: no subcommand, or a leading flag (svc.sh/systemd pass flags
  // and env, never a subcommand word). The boot graph continues untouched.
  if (!command || command.startsWith("-")) return false;
  cliEngaged = true;

  switch (command) {
    case "version":
      log(`subshell-server ${SERVER_VERSION}`);
      exit(0);
      return true;
    case "status":
      runStatus(log, deps);
      exit(0);
      return true;
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
      // transport CONNECTS (mcp-core's contract — the same one apps/client's
      // T18 fix documents); an `exit(0)` here — or even returning `true`,
      // which cli-bootstrap's `.then(handled ⇒ exit 0)` would act on —
      // kills the live transport milliseconds after `ready`. This is the
      // server twin of apps/client's keepAlive: PARK the dispatch promise so
      // nothing downstream can exit, and let the transport's stdin listener
      // own the process lifetime. When the pane's client disconnects, the
      // stream ends, the drained event loop ends the process (0) naturally,
      // and this promise never settles.
      return new Promise<boolean>(() => {});
    case "init":
    case "configure": {
      const opts = parseConfigFlags(argv.slice(1), error);
      if (!opts) {
        error(USAGE);
        exit(1);
        return true;
      }
      const cmdDeps: CommandDeps = {
        prompt: deps.prompt ?? promptLineSync,
        log,
        error,
        configDir: deps.configDir ?? serverConfigDir(),
        env: deps.env ?? process.env,
        which: deps.which ?? ((name) => Bun.which(name) ?? null),
        isTTY: deps.isTTY ?? process.stdin.isTTY === true,
      };
      // runInit/runConfigure are fully synchronous (invariant 1) and return
      // the exit code; the command itself never calls exit — this line does.
      exit(command === "init" ? runInit(opts, cmdDeps) : runConfigure(opts, cmdDeps));
      return true;
    }
    case "service": {
      // `service install|uninstall` (client cli.ts UX: an unknown verb is a
      // usage error). The verb is the ONLY positional; anything else is the
      // same "unexpected argument" refusal the config flags use.
      const verb = argv[1];
      if (verb !== "install" && verb !== "uninstall") {
        error(
          verb === undefined
            ? "subshell-server: service requires 'install' or 'uninstall'"
            : `subshell-server: unknown service command '${verb}'`,
        );
        error(USAGE);
        exit(1);
        return true;
      }
      if (argv.length > 2) {
        error(`subshell-server: unexpected argument '${argv[2] as string}'`);
        error(USAGE);
        exit(1);
        return true;
      }
      // Sync end to end (invariant 1): DEFAULT_DEPS runs manager commands via
      // Bun.spawnSync and writes the unit/plist with sync fs — no await ever
      // opens the boot graph. service.ts owns every decision; this case only
      // assembles deps from the seams and routes the result to stdio.
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
      });
      if (deps.runCmd) sdeps.runCmd = deps.runCmd;
      const result = verb === "install" ? installService(sdeps) : uninstallService(sdeps);
      // out/err arrive pre-newline-terminated; log/error append their own.
      if (result.out !== "") log(result.out.replace(/\n+$/, ""));
      if (result.err !== "") error(result.err.replace(/\n+$/, ""));
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

/** Value-taking flags of `init`/`configure` (client `cli.ts` pattern — no flag library). */
const CONFIG_VALUE_FLAGS = new Set(["--port", "--host", "--base-url", "--db-path"]);

/**
 * Hand-rolled `init`/`configure` flag parser: `--port <n> --host <h>
 * --base-url <u> --db-path <p> --yes`, with the `--flag=value` form accepted
 * alongside (split on the FIRST `=`, so values may contain `=`). Raw strings
 * — range/URL validation is the command's job (its messages are unit-tested);
 * this layer only owns shape: unknown flag, stray positional, missing or
 * empty value, and `--yes` with a value all mean "usage + exit 1".
 *
 * @returns the parsed options, or null after writing the error line
 */
function parseConfigFlags(rest: string[], error: (line: string) => void): ConfigureOpts | null {
  const opts: ConfigureOpts = {};
  const takeValue = (flag: string, inline: string | undefined, next: string | undefined): string | null => {
    const value = inline ?? next;
    if (value === undefined || (inline === undefined && value.startsWith("--")) || value === "") {
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
    if (flag === "--yes") {
      if (inline !== undefined) {
        error(`subshell-server: flag '--yes' takes no value`);
        return null;
      }
      opts.yes = true;
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
    }
  }
  return opts;
}

/** Decode a line's worth of bytes collected one at a time from stdin. */
const decodeLine = (bytes: number[]): string => Buffer.from(bytes).toString("utf8").replace(/\r$/, "");

/**
 * Production prompt: `writeSync(1, …)` + one-byte blocking `readSync(0, …)`
 * until LF. Deliberately NOT readline — readline is promise/event-driven and
 * would suspend the prelude, breaking cli.ts invariant 1 (the boot graph
 * imports the moment the command awaits — see the module docstring). A
 * canonical-mode TTY delivers whole lines, so byte-at-a-time reads simply
 * block on the tty driver; multi-byte UTF-8 reassembles at decode. EOF
 * (Ctrl-D, or a closed stdin) returns null so the caller aborts with zero
 * writes. EAGAIN (a non-blocking stdin under some launcher) parks briefly
 * and retries rather than fabricating an answer.
 */
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

/**
 * `status` — the operator's "what WOULD this boot with" view, printed
 * SYNCHRONOUSLY (invariant 1): the config.env path + existence, the
 * env-derived settings as they resolve through
 * `process env > config.env > default` (the same precedence `loadConfigEnv`
 * implements, read purely via `resolveConfig` — nothing is mutated), the
 * auth secret as masked-or-missing (its VALUE is never echoed, client
 * `status` precedent), tmux presence, and whether the resolved port already
 * has a listener.
 *
 * NOTE: this is the three-layer view only. The repo `.env`-via-dotenvx layer
 * is applied at `constants.ts` import time by the BOOT path, which `status`
 * deliberately never evaluates (see invariant 3 above) — and
 * under `bun run`/compiled binaries Bun itself preloads `.env` before ANY
 * user code, so a `.env` key is already "process env" by dispatch time.
 */
function runStatus(log: (line: string) => void, deps: CliDeps): void {
  const cfg = resolveConfig();
  // Layer attribution. The prelude applies config.env to process.env BEFORE
  // dispatch (the boot path needs it), so a file-sourced key is already
  // indistinguishable by presence — match the value against the file instead.
  // A real env var that happens to equal its config.env line reports as
  // config.env: harmless, both layers agree.
  const tag = (key: string): string => {
    if (process.env[key] === undefined) return cfg.values[key] !== undefined ? "config.env" : "default";
    if (cfg.values[key] === process.env[key]) return "config.env";
    return "process env";
  };
  const field = (key: string, value: string): void => {
    log(`${key.padEnd(20)} = ${value}  (${tag(key)})`);
  };

  log(`config.env: ${cfg.path} (${cfg.exists ? "present" : "missing"})`);
  // Mirrors of constants.ts defaults (imported by the boot path only; kept in
  // sync deliberately — importing constants here would run dotenvx in a CLI
  // process). SERVER_PORT/HOST/APP_BASE_URL defaults live there.
  const port = cfg.get("SERVER_PORT") ?? "3080";
  const host = cfg.get("HOST") ?? "127.0.0.1";
  field("SERVER_PORT", port);
  field("HOST", host);
  field("APP_BASE_URL", cfg.get("APP_BASE_URL") ?? `http://localhost:${port}`);
  field("DATABASE_PATH", cfg.get("DATABASE_PATH") ?? DEFAULT_DATABASE_PATH);
  // Never echo the secret — masked/missing is all status reveals.
  const secret = cfg.get("BETTER_AUTH_SECRET");
  log(`BETTER_AUTH_SECRET   = ${secret !== undefined ? "set (masked)" : "MISSING"}  (${tag("BETTER_AUTH_SECRET")})`);

  const tmux = Bun.which("tmux");
  log(`tmux                 = ${tmux ?? "NOT FOUND — install tmux (apt install tmux / brew install tmux)"}`);

  // Can THIS process spawn `subshell mcp`? Every subshell create registers it
  // into the harness config, so an unresolvable entrypoint means create 500s
  // — rare now that binaries self-resolve: the remaining miss is a
  // bun-interpreted run with no usable argv[1] and no `subshell` agent on
  // PATH (or an exotic execPath), and it hides until a user clicks create.
  // The probe reads the merged env (the prelude applied config.env before
  // dispatch), so SUBSHELL_MCP_COMMAND from the file counts.
  const mcpProbe = probeMcpLaunch(process.env, deps.mcpIo ?? {});
  log(
    mcpProbe.spec
      ? `mcp entrypoint       = ${[mcpProbe.spec.command, ...mcpProbe.spec.args].join(" ")}  (via ${mcpProbe.source})`
      : `mcp entrypoint       = UNRESOLVED — subshell create will fail; ${mcpProbe.error}`,
  );

  // Liveness: is something already listening on the resolved port? A bind
  // there would EADDRINUSE the boot, so "likely running" is the actionable
  // half of this line. 0.0.0.0/:: are bind addresses, never dial targets —
  // the LISTEN-table check uses them as-is only for reporting.
  const dialHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const portNum = Number.parseInt(port, 10);
  const valid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const up = valid ? ((deps.probePort ?? syncPortListening)(dialHost, portNum) ?? false) : false;
  log(`port ${port} on ${dialHost}: ${up ? "likely running" : "not listening"}`);

  // Service definition on disk: the existsSync truth of where
  // `service install` writes (a DEFINITION line, not a liveness line — the
  // port probe above covers "is it running"; a unit can be installed and
  // stopped). Cheap + sync, per invariant 1.
  const svc = serviceArtifactPath(deps.platform ?? process.platform, deps.home ?? homedir());
  if (svc === null) {
    log("service              = n/a (no per-user service manager on this platform)");
  } else {
    log(`service              = ${existsSync(svc) ? `definition installed (${svc})` : `not installed (${svc})`}`);
  }
}

/**
 * Synchronous "is anything LISTENing on this port" check. A TCP connect is
 * the obvious probe but it is inherently async — and async suspends the
 * entry mid-command (see invariant 1 in this module) — so status reads the
 * kernel's listener tables instead: `/proc/net/tcp{,6}` on Linux (state 0A
 * = LISTEN), `netstat -an -p tcp` on macOS, plain `netstat -tnl` elsewhere.
 * Returns null when no source is available (degrades to "not listening" —
 * same as before, this is a hint line, not an oracle).
 */
export function syncPortListening(_host: string, port: number): boolean | null {
  if (process.platform === "linux") {
    let sawAny = false;
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text: string;
      try {
        text = readFileSync(table, "utf8");
      } catch {
        continue;
      }
      sawAny = true;
      for (const line of text.split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        // sl local_address rem_address st tx_queue… — local is HEXIP:HEXPORT
        if (f[3] === "0A" && Number.parseInt(f[1]?.split(":")[1] ?? "", 16) === port) return true;
      }
    }
    if (sawAny) return false; // tables readable and silent — genuinely nobody listens
  }
  const args = process.platform === "darwin" ? ["-an", "-p", "tcp"] : ["-tnl"];
  const res = Bun.spawnSync({ cmd: ["netstat", ...args], stdout: "pipe", stderr: "ignore", timeout: 1000 });
  if (res.exitCode !== 0) return null; // no netstat — no answer available
  // Shared column layout on both spellings:
  //   Proto Recv-Q Send-Q Local-Address Foreign State  → f[3] local, f[5] LISTEN.
  // macOS separates the port with "." (127.0.0.1.3080), Linux with ":3080".
  for (const line of res.stdout.toString().split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[5] !== "LISTEN") continue;
    const local = f[3] ?? "";
    const sep = Math.max(local.lastIndexOf(":"), local.lastIndexOf("."));
    if (Number.parseInt(local.slice(sep + 1), 10) === port) return true;
  }
  return false;
}
