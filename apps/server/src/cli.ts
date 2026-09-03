import { readFileSync, readSync, writeSync } from "node:fs";
import { DEFAULT_DATABASE_PATH } from "@internal/subshell-protocol";
import { type CommandDeps, type ConfigureOpts, runConfigure } from "@/commands/configure.js";
import { runInit } from "@/commands/init.js";
import { resolveConfig, serverConfigDir } from "@/config-env.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * Hand-rolled subcommand dispatch for the `subshell-server` binary
 * (client `cli.ts` precedent — no flag library). The rule that keeps the
 * svc.sh/systemd boot contract byte-identical: `dispatchCli` returns FALSE
 * for anything that is not a known subcommand (no args, or a leading flag),
 * and the caller falls through to booting the server.
 *
 * Two load-bearing invariants, both forced by how Bun runs the entry graph
 * (measured on bun 1.4.0, NOT spec behaviour — Node would serialise):
 *
 * 1. A handled command MUST run and exit synchronously inside `dispatchCli`
 *    (via `deps.exit`, default `process.exit`). The entry prelude
 *    (`cli-bootstrap.ts`) therefore never `await`s before exit: any
 *    suspension — even `await null` — lets Bun evaluate the REST of the
 *    entry graph and even the entry body while the await is pending, which
 *    would boot the server on `subshell-server version`. This is why the
 *    interactive `init`/`configure` are written FULLY SYNCHRONOUSLY (sync
 *    fs + the `readSync(0, …)` prompt below): a readline-based command would
 *    suspend, `@/auth.js` would build better-auth in the gap — which OPENS
 *    the SQLite file, littering the CWD with `data/subshell.db` — and the
 *    engaged-flag gate would save only the port bind, not the DB. Verified
 *    subprocess-side in `__tests__/cli-entry.test.ts`.
 * 2. `dispatchCli` sets the engaged flag synchronously, before its first
 *    possible await, so the entry body (which evaluates inside any such
 *    window) sees it — the last-resort net, not something a command may
 *    rely on (see 1).
 *
 * Import hygiene: this module must stay free of import-time side effects —
 * no `@/constants.js` (dotenvx runs at ITS import time), no `@/db` (Kysely
 * opens lazily now, but `@/auth.js` still builds better-auth at import).
 * Only leaf modules are imported at the top level.
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
  /** Interactive-TTY signal for the command flows (default: `process.stdin.isTTY`). */
  isTTY?: boolean;
}

const USAGE = `subshell-server — the Subshell control plane

usage:
  subshell-server                run the server (boot path: no subcommand)
  subshell-server version        print the version and exit
  subshell-server status         print the resolved config view and exit
  subshell-server init           first run: config home + auth secret + config.env
  subshell-server configure      (re)write config.env; interactive unless --yes

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
 * deliberately never evaluates (see the import-hygiene note above) — and
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

  // Liveness: is something already listening on the resolved port? A bind
  // there would EADDRINUSE the boot, so "likely running" is the actionable
  // half of this line. 0.0.0.0/:: are bind addresses, never dial targets —
  // the LISTEN-table check uses them as-is only for reporting.
  const dialHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const portNum = Number.parseInt(port, 10);
  const valid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const up = valid ? ((deps.probePort ?? syncPortListening)(dialHost, portNum) ?? false) : false;
  log(`port ${port} on ${dialHost}: ${up ? "likely running" : "not listening"}`);
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
