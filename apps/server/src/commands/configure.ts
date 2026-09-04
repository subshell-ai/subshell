import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "@/config-env.js";
import { chooseTmuxInstaller, runTmuxInstall, spawnInherit } from "./tmux-install.js";

/**
 * `subshell-server configure` — (re)write `<configDir>/config.env` from the
 * first-run questions, non-interactive under `--yes`/non-TTY, flag-override
 * anywhere. `init` (commands/init.ts) runs the same flow after seeding the
 * auth secret.
 *
 * The whole command is SYNCHRONOUS by contract — every fs call is the sync
 * API, and the interactive prompt reads stdin with `readSync(0, …)` (cli.ts
 * `promptLineSync`). That is not style, it is the entry's invariant 1
 * (cli.ts/cli-bootstrap.ts): a handled CLI command must run to completion
 * and `process.exit` INSIDE the first-imported prelude body, because Bun
 * (measured 1.4.0, Task B audit + the Task C spike) evaluates the rest of
 * `index.ts`'s imports the moment the command suspends — and `@/auth.js`
 * opens the SQLite file inside better-auth's constructor. An async (readline
 * based) configure would therefore litter the CWD with `data/subshell.db`
 * even though the boot gate keeps it from binding the port. Sync commands
 * never import the boot graph at all: zero files, zero listeners, proven by
 * `src/__tests__/cli-entry.test.ts` in a real subprocess.
 *
 * Preservation contract for the rewrite: the four keys this flow owns
 * (`SERVER_PORT`, `HOST`, `APP_BASE_URL`, `DATABASE_PATH`) are written from
 * the answers; EVERY other key in the existing file — above all the
 * once-generated `BETTER_AUTH_SECRET` — is carried forward verbatim, key
 * order included. Comments are NOT preserved (documented in the file header
 * itself); `config.env` is generated output, not an edited artifact.
 *
 * Prompt defaults follow the file: when an interactive re-run finds a stored
 * value for a question, that value is the default (ENTER keeps it), so
 * pressing ENTER through a configured install no longer resets a customised
 * port/host/etc. to the built-ins. `--yes`/non-TTY semantics are unchanged —
 * built-in defaults + flags only.
 */

/** Env var that skips the tmux preflight (mirrors the client's escape hatch). */
export const SKIP_TMUX_CHECK_ENV = "SUBSHELL_SERVER_SKIP_TMUX_CHECK";

/** The four keys `configure` owns; the rest of config.env belongs to other writers. */
export const OWNED_KEYS = ["SERVER_PORT", "HOST", "APP_BASE_URL", "DATABASE_PATH"] as const;

/**
 * Fully injected seams for the init/configure commands — commands read
 * NOTHING from `process.*` directly, so unit tests pin every side effect.
 */
export interface CommandDeps {
  /**
   * Interactive prompt: renders `question [default]: ` and reads one stdin
   * line. Returns the raw answer (possibly empty → caller takes the default)
   * or `null` on EOF (Ctrl-D → the command aborts with zero writes).
   */
  prompt: (question: string, def: string) => string | null;
  /** stdout line sink (results, warnings). */
  log: (line: string) => void;
  /** stderr sink (refusals, validation errors). */
  error: (line: string) => void;
  /** The server config home (`serverConfigDir()` in production). */
  configDir: string;
  /** Env source for the tmux escape hatch (production: `process.env`). */
  env: Record<string, string | undefined>;
  /** Executable lookup for the tmux preflight (production: `Bun.which`). */
  which: (name: string) => string | null;
  /** True when stdin is an interactive TTY (production: `process.stdin.isTTY`). */
  isTTY: boolean;
  /** Runtime platform for the tmux offer's installer detection (production: `process.platform`). */
  platform?: NodeJS.Platform;
  /**
   * Sync package-manager runner for the tmux offer (production:
   * `spawnInherit` from tmux-install.ts). Injectable so suites pin the
   * offer flow without touching a real installer.
   */
  spawnInstall?: (argv: readonly string[]) => number;
}

/**
 * The offer-to-install bundle for the tmux preflight (spec 2026-09-03):
 * present-and-`interactive` is the ONLY way the offer can fire — callers
 * compute `interactive` as `!--yes && TTY` (init/configure) or plain TTY
 * (service install has no flags). CI, scripts, and piped stdin see the
 * status-quo refusal; a system-package install is never the silent
 * consequence of a flag.
 */
export interface TmuxOffer {
  /** Caller-computed interactivity gate — the offer's master switch. */
  interactive: boolean;
  /** Where the offer's question/progress lines go (stdout in production). */
  log: (line: string) => void;
  /** The y/N question (production: `promptLineSync`); null/EOF = declined. */
  prompt: (question: string, def: string) => string | null;
  /** Installer runner (default: `spawnInherit` — inherited stdio). */
  spawn?: (argv: readonly string[]) => number;
}

/**
 * The config flows' ONE offer bundle: `init` and `configure` gate
 * identically (`!--yes` AND TTY), and both take it from here so the gate
 * cannot drift between the two commands. Platform is NOT part of the offer
 * — it rides on {@link TmuxPreflightDeps.platform} where the preflight also
 * resolves the hint text from, one source for both.
 */
export function makeTmuxOffer(opts: ConfigureOpts, deps: CommandDeps): TmuxOffer {
  return {
    interactive: !opts.yes && deps.isTTY,
    log: deps.log,
    prompt: deps.prompt,
    spawn: deps.spawnInstall,
  };
}

/** Parsed `init`/`configure` flags — raw strings, validated by the flow. */
export interface ConfigureOpts {
  /** `--port`: overrides the port question. */
  port?: string;
  /** `--host`: overrides the bind-address question. */
  host?: string;
  /** `--base-url`: overrides the base-URL question. */
  baseUrl?: string;
  /** `--db-path`: overrides the database-path question. */
  dbPath?: string;
  /** `--yes` (also implied by non-TTY): accept all defaults/flags, ask nobody. */
  yes?: boolean;
}

/**
 * The slice of {@link CommandDeps} the tmux preflight consumes. A named type
 * so `service install` (its own deps shape) reuses the SAME helper — the plan
 * mandates the preflight in both places, one message and one escape hatch.
 */
export interface TmuxPreflightDeps {
  /** Env source for the escape hatch (production: `process.env`). */
  env: Record<string, string | undefined>;
  /** Executable lookup (production: `Bun.which`). */
  which: (name: string) => string | null;
  /** stderr sink (the refusal lines land here). */
  error: (line: string) => void;
  /**
   * Offer-to-install bundle (absent or non-interactive ⇒ the preflight is
   * exactly its pre-offer self: refuse with the platform hint).
   */
  offer?: TmuxOffer;
  /**
   * Runtime platform for BOTH the installer detection and the hint text
   * (production: `process.platform` — the CommandDeps rule is "read nothing
   * from `process.*` directly", so it arrives here as a dep).
   */
  platform?: NodeJS.Platform;
}

/**
 * tmux preflight — the server's `local` node launches every pane through
 * tmux, so refuse `init`/`configure`/`service install` before any write when
 * it is missing. Mirrors the client's enroll-time style: platform hint +
 * escape hatch name (spec 2026-09-03 plan-2 Global Constraints).
 *
 * Since spec 2026-09-03 (tmux offer): an interactive run with a supported
 * installer on PATH gets ONE chance to `brew/apt-get/dnf install tmux`
 * on the spot — and CONTINUES the command on success (no rerun). Every
 * non-success path (no offer, non-interactive, no installer, declined,
 * EOF, failed install, still-not-found) is the original refusal, verbatim.
 *
 * @returns true when the flow may proceed (tmux present/skip var/offered install)
 */
export function tmuxPreflight(deps: TmuxPreflightDeps): boolean {
  if (deps.env[SKIP_TMUX_CHECK_ENV] === "1") return true;
  if (deps.which("tmux") !== null) return true;
  const platform = deps.platform ?? process.platform;
  const offer = deps.offer;
  if (offer?.interactive) {
    const installer = chooseTmuxInstaller({ platform, which: deps.which });
    if (installer) {
      offer.log(
        "tmux not found — the server launches its local subshells through tmux. " +
          `It can be installed right now with ${installer.label}.`,
      );
      offer.log(`this would run: ${installer.argv.join(" ")}`);
      const answer = offer.prompt(`Install tmux now with ${installer.label}?`, "n");
      if (answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase())) {
        // note=offer.log: an unstartable installer (bun throws ENOENT before
        // any child output) must explain itself, not fall back silently.
        const found = runTmuxInstall(installer, {
          spawn: offer.spawn ?? spawnInherit,
          which: deps.which,
          note: offer.log,
        });
        if (found) {
          offer.log(`tmux installed (${found}) — continuing.`);
          return true;
        }
        offer.log("tmux was not installed — falling back to the manual steps.");
      }
    }
  }
  deps.error("tmux not found — the server launches its local subshells through tmux and cannot run without it.");
  const hint =
    platform === "darwin"
      ? "Install it first (macOS: brew install tmux)"
      : platform === "linux"
        ? "Install it first (Debian/Ubuntu: apt install tmux; Fedora: dnf install tmux)"
        : "Install tmux first (Linux: apt install tmux / dnf install tmux; macOS: brew install tmux)";
  deps.error(`${hint} and rerun (escape hatch: ${SKIP_TMUX_CHECK_ENV}=1).`);
  return false;
}

/** Create the config home if absent, and keep it 0700 (it holds the auth secret). */
export function ensureConfigDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-clamped and only applies to created segments; the
  // home is re-asserted unconditionally so an old 0755 one gets tightened.
  chmodSync(dir, 0o700);
}

/**
 * Parsed contents of the existing `config.env` ({} when absent). ANY other
 * read failure rethrows — the callers refuse to clobber a file they could
 * not read.
 */
export function readExistingConfig(dir: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(join(dir, "config.env"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Atomic `config.env` write: temp file in the same directory (0600 — the
 * mode is creation-only, so chmod it explicitly past the umask) + rename.
 * Ensures the config home first. The mtime-keyed readers none; the rename
 * swap is what makes a concurrent systemd EnvironmentFile read see either
 * the old file or the new one, never a half-written one.
 *
 * @returns the absolute path written
 */
export function writeConfigEnv(dir: string, values: Record<string, string>): string {
  ensureConfigDir(dir);
  const target = join(dir, "config.env");
  const tmp = join(dir, `.config.env.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const body = [
    "# subshell-server configuration — systemd EnvironmentFile syntax (bare KEY=value lines, no quotes).",
    "# Written by `subshell-server init`/`configure`: comments here do NOT survive a rewrite, but keys",
    "# this tool does not own (e.g. BETTER_AUTH_SECRET, TRUSTED_ORIGINS) are carried forward verbatim.",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return target;
}

/** True for a URL string that parses and speaks http(s). */
function isHttpUrl(value: string): boolean {
  try {
    const proto = new URL(value).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/**
 * Loopback test on a parsed URL's host — mirrors the frontend's
 * `add-node-dialog` helper (enroll-time loopback trap, spec 2026-08-31):
 * localhost, any 127.x, and the bracketed/bare IPv6 spellings.
 */
function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host.startsWith("127.") || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** Validate one resolved value; null = acceptable, string = stderr message. */
function validateOwned(key: (typeof OWNED_KEYS)[number], value: string): string | null {
  if (/[\r\n]/.test(value)) {
    return `invalid ${key}: the value must be a single line (it would corrupt config.env)`;
  }
  switch (key) {
    case "SERVER_PORT": {
      if (!/^\d+$/.test(value)) return `invalid port '${value}': expected an integer 1-65535`;
      const n = Number.parseInt(value, 10);
      if (n < 1 || n > 65535) return `invalid port '${value}': expected an integer 1-65535`;
      return null;
    }
    case "HOST":
      return value.trim() === ""
        ? "invalid host: must not be empty (127.0.0.1 or 0.0.0.0 are the usual answers)"
        : null;
    case "APP_BASE_URL":
      return isHttpUrl(value)
        ? null
        : `invalid base-url '${value}': expected a full http(s) URL (e.g. http://localhost:3080)`;
    case "DATABASE_PATH":
      return value.trim() === "" ? "invalid database path: must not be empty" : null;
  }
}

/**
 * Run the configure flow: tmux preflight → read the existing config.env (an
 * unreadable one is refused BEFORE any question is spent) → resolve each
 * answer (flag > prompt under TTY-and-no-`--yes` > default) with immediate
 * per-answer validation → LAN/loopback warning → atomic
 * preservation-preserving rewrite of config.env. NOTHING is written before
 * the last validation passes.
 *
 * Interactive prompt defaults are the CURRENT stored values (falling back to
 * the built-ins per key when the file has none), so an ENTER-through re-run
 * keeps a customised install. `--yes`/non-TTY still answer with built-in
 * defaults + flags only.
 *
 * @param opts - parsed flags (`--port --host --base-url --db-path --yes`)
 * @param deps - injected stdio/IO/env seams; the command touches no other globals
 * @returns process exit code — 0 on success, 1 on refusal/validation failure
 *   (cli.ts hands this to `deps.exit`; the command never calls exit itself)
 */
export function runConfigure(opts: ConfigureOpts, deps: CommandDeps): number {
  // The interactivity gate is decided BEFORE the preflight: the tmux offer
  // may fire only here (spec 2026-09-03) — `--yes`/non-TTY keep the refusal.
  const interactive = !opts.yes && deps.isTTY;
  if (!tmuxPreflight({ ...deps, offer: makeTmuxOffer(opts, deps) })) return 1;

  // Read the existing file BEFORE asking: its values become the interactive
  // defaults, and a file we cannot read is refused before a single question
  // (never clobber what you cannot read). The same map backs the preservation
  // merge at the bottom — no second read.
  let existing: Record<string, string>;
  try {
    existing = readExistingConfig(deps.configDir);
  } catch (err) {
    deps.error(`subshell-server: refusing to rewrite ${join(deps.configDir, "config.env")}: ${(err as Error).message}`);
    return 1;
  }

  /** Prompt default for one owned key: the stored value when interactive, else the built-in. */
  const dflt = (key: (typeof OWNED_KEYS)[number], builtin: string): string =>
    (interactive ? existing[key] : undefined) ?? builtin;
  /** Resolve one answer (flag > trimmed prompt/ENTER-default > default); null = EOF. */
  const ask = (question: string, def: string, flag: string | undefined): string | null => {
    if (flag !== undefined) return flag.trim();
    if (!interactive) return def;
    const answer = deps.prompt(question, def);
    if (answer === null) return null;
    const trimmed = answer.trim();
    return trimmed === "" ? def : trimmed;
  };
  /**
   * Resolve + validate one owned key. Null means "aborted": the reason is
   * already on stderr (EOF notice or the validation message) and the caller
   * returns 1 — every question is validated the moment it is answered, so an
   * interactive typo dies at that prompt, never after collecting the rest.
   */
  const resolve = (
    key: (typeof OWNED_KEYS)[number],
    question: string,
    def: string,
    flag: string | undefined,
  ): string | null => {
    const value = ask(question, def, flag);
    if (value === null) {
      deps.error("stdin closed before all answers were given — nothing was written.");
      return null;
    }
    const invalid = validateOwned(key, value);
    if (invalid) {
      deps.error(invalid);
      return null;
    }
    return value;
  };

  const port = resolve("SERVER_PORT", "Server port", dflt("SERVER_PORT", "3080"), opts.port);
  if (port === null) return 1;
  const host = resolve(
    "HOST",
    "Bind address — stay loopback-only, or bind LAN? type 0.0.0.0",
    dflt("HOST", "127.0.0.1"),
    opts.host,
  );
  if (host === null) return 1;
  // The base-URL default follows the ANSWERED port (constants.ts derives it
  // from SERVER_PORT at boot too — mirrors each other) unless the file stores
  // one — then the stored URL is the default, unchanged.
  const baseUrl = resolve(
    "APP_BASE_URL",
    "Public base URL (browsers and remote nodes dial this)",
    dflt("APP_BASE_URL", `http://localhost:${port}`),
    opts.baseUrl,
  );
  if (baseUrl === null) return 1;
  const dbPath = resolve(
    "DATABASE_PATH",
    "SQLite database file",
    dflt("DATABASE_PATH", join(deps.configDir, "subshell.db")),
    opts.dbPath,
  );
  if (dbPath === null) return 1;

  // The enroll-time loopback trap (spec 2026-08-31), warned at write time:
  // a LAN bind with a loopback base URL makes every REMOTE node dial its own
  // box. Warned, then accepted — flags and scripted answers outrank taste.
  if (host === "0.0.0.0" && isLoopbackUrl(baseUrl)) {
    deps.log(
      `warning: HOST=0.0.0.0 (LAN bind) but APP_BASE_URL is loopback (${baseUrl}) — remote nodes will dial ` +
        "their OWN machine, not this server. Set a reachable APP_BASE_URL (e.g. http://<lan-ip>:" +
        `${port}) unless every node is this box.`,
    );
  }

  const values: Record<string, string> = {
    ...existing,
    SERVER_PORT: port,
    HOST: host,
    APP_BASE_URL: baseUrl,
    DATABASE_PATH: dbPath,
  };
  const target = writeConfigEnv(deps.configDir, values);
  deps.log(`wrote ${target} (0600)`);
  for (const key of OWNED_KEYS) deps.log(`  ${key} = ${values[key]}`);
  deps.log("restart the server (or start it with: subshell-server) to apply.");
  return 0;
}
