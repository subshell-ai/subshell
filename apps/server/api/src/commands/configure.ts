import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "@/config-env.js";
import {
  baseUrlPort,
  type ConfigKey,
  FLAG_FOR_KEY,
  isLoopbackUrl,
  normalizeTrustedOrigins,
  OPTIONAL_KEYS,
  OWNED_KEYS,
  validateValue,
} from "./config-values.js";
import { chooseTmuxInstaller, runTmuxInstall, spawnInherit } from "./tmux-install.js";

/**
 * `subshell-server configure` — (re)write `<configDir>/config.env` from the
 * first-run questions, non-interactive under `--yes`/non-TTY, flag-override
 * anywhere. `init` (commands/init.ts) runs the same flow after seeding the
 * auth secret.
 *
 * Every fs call is still the SYNC API, and that half has not changed. What
 * did change is the prompt: it is `@clack/prompts` now (spec 2026-09-15
 * §3.2), so this command suspends, like `mcp` already did. That is legal
 * because what keeps a suspended command safe was never the exit style — it
 * is cli.ts's two invariants: the entry graph is IO-FREE AT IMPORT (lazy
 * `getAuth()`, so nothing opens SQLite merely by being evaluated) and
 * `isCliEngaged()` flips synchronously at subcommand recognition, so the boot
 * body cannot run underneath a command that is waiting for an answer. The
 * historical hazard — an async configure littering the CWD with
 * `data/subshell.db` because `@/auth.js` opened it at import — is gone with
 * the eager construction that caused it, and `src/__tests__/cli-entry.test.ts`
 * pins its absence in a real subprocess.
 *
 * Preservation contract for the rewrite: the four keys in {@link OWNED_KEYS}
 * are written from the answers, {@link OPTIONAL_KEYS} is written or removed
 * from its answer, and EVERY other key in the existing file — above all the
 * once-generated `BETTER_AUTH_SECRET` — is carried forward verbatim, key
 * order included. Comments are NOT preserved (documented in the file header
 * itself); `config.env` is generated output, not an edited artifact.
 *
 * Defaults follow the FILE, in every mode: a stored value is the default for
 * its question, so ENTER through an interactive re-run — and a `--yes` run
 * given no flag for that key — keeps what is already configured rather than
 * resetting it to a built-in. Flags outrank the file everywhere. See
 * `dflt` in {@link runConfigure} for why non-interactive runs had to change.
 */

export type { ConfigKey } from "./config-values.js";
export { FLAG_FOR_KEY, OPTIONAL_KEYS, OWNED_KEYS } from "./config-values.js";

/** Env var that skips the tmux preflight (mirrors the agent's escape hatch). */
export const SKIP_TMUX_CHECK_ENV = "SUBSHELL_SERVER_SKIP_TMUX_CHECK";

/**
 * Fully injected seams for the init/configure commands — commands read
 * NOTHING from `process.*` directly, so unit tests pin every side effect.
 */
export interface CommandDeps {
  /**
   * Interactive prompt for the config questions: asks one thing, shows the
   * default, returns the raw answer (empty → the caller takes the default) or
   * `null` when the person cancelled or stdin closed (the command then aborts
   * with zero writes).
   *
   * Promise-returning in production (`@clack/prompts`'s `text`, wired in
   * `cli.ts`); the union still accepts the plain function every test injects,
   * which is why the seam did not have to move when the implementation did.
   */
  prompt: (question: string, def: string) => string | null | Promise<string | null>;
  /**
   * Yes/no question, with `def` rendered as the pre-selected answer
   * (production: `@clack/prompts`'s `confirm`). `null` is a cancel.
   *
   * Separate from {@link CommandDeps.prompt} because the two render
   * differently and a caller should not have to parse "y"/"yes" out of a text
   * answer to find out what was meant.
   */
  confirm: (question: string, def: boolean) => boolean | null | Promise<boolean | null>;
  /**
   * The tmux offer's own prompt, and the reason it is a SECOND text seam
   * rather than {@link CommandDeps.prompt}: `tmuxPreflight` is shared with
   * `service install`, whose `installService` is synchronous end to end
   * (cli.ts's sync convention, and it returns a `CliResult` rather than a
   * promise), so the offer cannot await an answer. Production wires
   * `promptLineSync`.
   */
  promptSync: (question: string, def: string) => string | null;
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
    prompt: deps.promptSync,
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
  /**
   * `--trusted-origins`: overrides the extra-origins question. A
   * comma-separated list of origins; the EMPTY string is a real answer
   * meaning "no extras", and removes the key (see {@link OPTIONAL_KEYS}).
   */
  trustedOrigins?: string;
  /** `--yes` (also implied by non-TTY): accept all defaults/flags, ask nobody. */
  yes?: boolean;
  /**
   * `--service` / `--no-service` (`init` only): install the background
   * service, or do not. Absent means "ask, and take yes when nobody can be
   * asked" — the opt-out exists for scripts and for the desktop apps, which
   * install the service themselves with their own autostart choice.
   */
  service?: boolean;
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
 * it is missing. Mirrors the agent's enroll-time style: platform hint +
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
        "tmux not found. The server launches its local subshells through tmux. " +
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
          offer.log(`tmux installed (${found}), continuing.`);
          return true;
        }
        offer.log("tmux was not installed, falling back to the manual steps.");
      }
    }
  }
  deps.error("tmux not found. The server launches its local subshells through tmux and cannot run without it.");
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
    "# subshell-server configuration, systemd EnvironmentFile syntax (bare KEY=value lines, no quotes).",
    "# Written by `subshell-server init`/`configure`: comments here do NOT survive a rewrite, but keys",
    "# this tool does not own (e.g. BETTER_AUTH_SECRET) are carried forward verbatim.",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return target;
}

/** What a caller wants changed; an absent field means "keep the stored value, or the built-in default". */
export interface ApplyConfigInput {
  /** `SERVER_PORT` as text (the CLI passes flag text; the route stringifies its number). */
  port?: string;
  /** `HOST`. */
  host?: string;
  /** `APP_BASE_URL`. */
  baseUrl?: string;
  /** `TRUSTED_ORIGINS`, comma-joined; the empty string CLEARS the key. */
  trustedOrigins?: string;
  /** `DATABASE_PATH` (CLI only; the route never sends it). */
  dbPath?: string;
}

/** One key the caller asked to change whose stored value the write actually changed. */
export interface ConfigChange {
  /** The config.env key. */
  key: ConfigKey;
  /** What the file held before, or undefined when the key was absent. */
  from: string | undefined;
  /** What the file holds now, or undefined when the key was removed. */
  to: string | undefined;
}

/**
 * Outcome of {@link applyConfig}. The two failures are DISTINGUISHED rather
 * than sharing a `key`, because a caller renders them in different places: an
 * `invalid` belongs under the field that carries the offending value, and an
 * `unreadable` belongs to the file, not to any field. Naming a key for a read
 * failure would put "cannot read config.env" under the Port input.
 */
export type ApplyConfigResult =
  | {
      ok: true;
      /** Absolute path written. */
      path: string;
      /** Every key in the file after the write (foreign keys included). */
      values: Record<string, string>;
      /** Advisory sentences the caller renders; never a refusal. */
      warnings: string[];
      /** The changes an audit log should record. */
      changed: ConfigChange[];
    }
  | {
      ok: false;
      /** A value failed `validateValue`. */
      kind: "invalid";
      /** The key that failed — the field a form should mark. */
      key: ConfigKey;
      /** `validateValue`'s sentence, verbatim — the same one the CLI prints. */
      reason: string;
    }
  | {
      ok: false;
      /** config.env exists but could not be read, so it must not be clobbered. */
      kind: "unreadable";
      /** The file that could not be read. */
      path: string;
      /** The underlying reason, already naming the path. */
      reason: string;
    };

/** The body fields {@link ApplyConfigInput} carries, paired with the key each one writes. */
const INPUT_FIELD_FOR_KEY = {
  SERVER_PORT: "port",
  HOST: "host",
  APP_BASE_URL: "baseUrl",
  DATABASE_PATH: "dbPath",
  TRUSTED_ORIGINS: "trustedOrigins",
} as const satisfies Record<ConfigKey, keyof ApplyConfigInput>;

/**
 * THE config.env writer: merge the input over the stored values (or the
 * built-in defaults), validate every key with `validateValue`, canonicalize
 * the origins, compute the two advisory warnings, and write the file
 * atomically, carrying every key this tool does not own forward verbatim.
 *
 * Shared by `configure`/`init` and by `PATCH /api/admin/server/config`, so
 * the CLI and the SPA cannot disagree about what a valid file is. No prompt,
 * no exit, no output: the caller renders the result.
 *
 * A value BYTE-IDENTICAL to what is already stored is kept (with a warning)
 * rather than refused — the CLI's long-standing leniency, so a hand-written
 * wildcard in `TRUSTED_ORIGINS` does not wedge a port change. Only a CHANGED
 * value has to satisfy the validator.
 *
 * `changed` reports only keys the CALLER named. A key the input omits is
 * resolved from the file or the built-in default, so materializing it (an
 * absent `HOST` becoming the `HOST=0.0.0.0` line it already meant) is not a
 * change anyone made, and an audit log that claimed otherwise would describe
 * a decision nobody took.
 */
export function applyConfig(input: ApplyConfigInput, configDir: string): ApplyConfigResult {
  let existing: Record<string, string>;
  try {
    existing = readExistingConfig(configDir);
  } catch (err) {
    const path = join(configDir, "config.env");
    return {
      ok: false,
      kind: "unreadable",
      path,
      reason: `refusing to rewrite ${path}: ${(err as Error).message}`,
    };
  }
  const warnings: string[] = [];
  /** Resolve + validate one key: given value, else the stored one, else the built-in. */
  const pick = (
    key: ConfigKey,
    given: string | undefined,
    builtin: string,
  ): { ok: true; value: string } | { ok: false; reason: string } => {
    const value = given === undefined ? (existing[key] ?? builtin) : given.trim();
    const invalid = validateValue(key, value);
    if (invalid === null) return { ok: true, value };
    // Preserving what the boot already reads grants nothing new, and refusing
    // it wedged every other key (see `runConfigure`'s own note).
    if (existing[key] === value) {
      warnings.push(
        `${key} kept as found in ${join(configDir, "config.env")}: ${invalid}. ` +
          `This tool will not write that value; pass ${FLAG_FOR_KEY[key]} to replace it.`,
      );
      return { ok: true, value };
    }
    return { ok: false, reason: invalid };
  };

  const port = pick("SERVER_PORT", input.port, "3080");
  if (!port.ok) return { ok: false, kind: "invalid", key: "SERVER_PORT", reason: port.reason };
  const host = pick("HOST", input.host, "0.0.0.0");
  if (!host.ok) return { ok: false, kind: "invalid", key: "HOST", reason: host.reason };
  const baseUrl = pick("APP_BASE_URL", input.baseUrl, `http://localhost:${port.value}`);
  if (!baseUrl.ok) return { ok: false, kind: "invalid", key: "APP_BASE_URL", reason: baseUrl.reason };
  const origins = pick("TRUSTED_ORIGINS", input.trustedOrigins, "");
  if (!origins.ok) return { ok: false, kind: "invalid", key: "TRUSTED_ORIGINS", reason: origins.reason };
  const dbPath = pick("DATABASE_PATH", input.dbPath, join(configDir, "subshell.db"));
  if (!dbPath.ok) return { ok: false, kind: "invalid", key: "DATABASE_PATH", reason: dbPath.reason };

  // Canonicalized here rather than at the write below, because the third
  // warning asks whether the list is EMPTY and " , " is a list that is.
  const normalizedOrigins = normalizeTrustedOrigins(origins.value);

  // The enroll-time loopback trap (spec 2026-08-31), warned at write time: a
  // LAN bind with a loopback base URL makes every REMOTE node dial its own
  // box. Warned, then accepted — flags and scripted answers outrank taste.
  if (host.value === "0.0.0.0" && isLoopbackUrl(baseUrl.value)) {
    warnings.push(
      `HOST=0.0.0.0 (LAN bind) but APP_BASE_URL is loopback (${baseUrl.value}); remote nodes will dial ` +
        "their OWN machine, not this server. Set a reachable APP_BASE_URL (e.g. http://<lan-ip>:" +
        `${port.value}) unless every node is this box.`,
    );
  }
  // The other half of the same trap: a stored base URL naming a port the
  // server will not listen on is the exact 403 "Invalid origin" this key
  // exists to prevent. A default-port base URL is a proxy, not a mismatch.
  const dialPort = baseUrlPort(baseUrl.value);
  if (dialPort !== null && dialPort !== 80 && dialPort !== 443 && String(dialPort) !== port.value) {
    warnings.push(
      `APP_BASE_URL is ${baseUrl.value} but the server will listen on ${port.value}; unless a proxy or an ` +
        `SSH forward on this host maps port ${dialPort} to ${port.value}, a browser dialing ${dialPort} reaches ` +
        `nothing, and one dialing ${port.value} by NAME is refused (403 "Invalid origin" — the exception is ` +
        `this machine's own addresses, which are derived and trusted automatically). Set --base-url to the ` +
        `address you actually browse, or add it to --trusted-origins.`,
    );
  }
  // The third face of the same trap, and what is LEFT of it. The trap used to
  // be total: on a wildcard bind with a loopback base URL the derived set was
  // the two loopback spellings, so a phone or a laptop on the LAN died on the
  // 403 that names nothing. The LAN probe (`services/lan-origins.ts`,
  // 2026-09-17) closed the ADDRESS half with no operator act at all — an
  // origin spelling one of this machine's own interface addresses is trusted
  // on sight — and the same probe cannot know, or spell, the NAMES this
  // machine answers to: `.local`, local DNS, anything else people type that
  // is not an interface address. That half still dies on the nameless 403,
  // which is still what this warning is for. Warned rather than refused, like
  // its two siblings: a box nobody browses by name is a legitimate
  // configuration.
  // EVERY configured origin loopback, not merely an EMPTY list. An explicit
  // `TRUSTED_ORIGINS=http://localhost:5174` names no extra spellings either,
  // so testing for "" alone stayed silent on the same configuration. The
  // dashboard's checklist item asks a different question now (does the
  // EFFECTIVE list hold anything non-loopback, kernel probe included), so the
  // two no longer fire together: a host with any interface address silences
  // the card while this warning still speaks about names, and both answers
  // are true of the machine being configured.
  const everyOriginLoopback = normalizedOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .every((entry) => isLoopbackUrl(entry));
  if (host.value === "0.0.0.0" && isLoopbackUrl(baseUrl.value) && everyOriginLoopback) {
    warnings.push(
      `HOST=0.0.0.0 (LAN bind) with a loopback APP_BASE_URL (${baseUrl.value}) and nothing but loopback in ` +
        "TRUSTED_ORIGINS: browsers reaching this server by one of this machine's OWN addresses sign in " +
        "fine — those origins are derived and trusted automatically — " +
        'but no NAME is: browsing by a `.local` host or a DNS entry answers 403 "Invalid origin" without ' +
        `naming the key that fixes it. Add the name (${FLAG_FOR_KEY.TRUSTED_ORIGINS} http://<that-name>:${port.value}), ` +
        `or make it the base URL (${FLAG_FOR_KEY.APP_BASE_URL} http://<that-name>:${port.value}).`,
    );
  }

  const values: Record<string, string> = {
    ...existing,
    SERVER_PORT: port.value,
    HOST: host.value,
    APP_BASE_URL: baseUrl.value,
    DATABASE_PATH: dbPath.value,
  };
  // Present-or-absent, never present-and-empty (see OPTIONAL_KEYS): an empty
  // value beats `.env` in the precedence ladder and silently strips the
  // built-in dev origins, which is the footgun this key exists to avoid.
  if (normalizedOrigins === "") delete values.TRUSTED_ORIGINS;
  else values.TRUSTED_ORIGINS = normalizedOrigins;

  const changed: ConfigChange[] = [];
  for (const key of [...OWNED_KEYS, ...OPTIONAL_KEYS] as ConfigKey[]) {
    if (input[INPUT_FIELD_FOR_KEY[key]] === undefined) continue;
    if (existing[key] !== values[key]) changed.push({ key, from: existing[key], to: values[key] });
  }
  const path = writeConfigEnv(configDir, values);
  return { ok: true, path, values, warnings, changed };
}

/**
 * Run the configure flow: tmux preflight → read the existing config.env (an
 * unreadable one is refused BEFORE any question is spent) → resolve each
 * answer (flag > prompt under TTY-and-no-`--yes` > default) → hand the five
 * answers to {@link applyConfig}, which validates them, computes the address
 * warnings and performs the atomic preservation-preserving rewrite. NOTHING
 * is written before every value validates.
 *
 * Validation moved into `applyConfig` when the SPA's `PATCH
 * /api/admin/server/config` became a second caller: one writer is what keeps
 * the two from disagreeing about what a valid file is. The visible
 * consequence is ordering — an invalid interactive answer is now reported
 * after the last question rather than at the prompt that produced it. The
 * messages are unchanged.
 *
 * Defaults are the CURRENT stored values in EVERY mode, falling back to the
 * built-ins per key when the file has none — see `dflt` below for why
 * `--yes`/non-TTY had to stop answering with the built-ins alone. So an
 * ENTER-through interactive re-run and a scripted run given no flag for a key
 * both keep a customised install; flags outrank the file everywhere.
 *
 * One consequence, handled in `resolve`: a value ALREADY in config.env can now
 * fail validation and block the command, so such a refusal names the file it
 * came from and the flag that replaces it.
 *
 * @param opts - parsed flags (`--port --host --base-url --trusted-origins
 *   --db-path --yes`)
 * @param deps - injected stdio/IO/env seams; the command touches no other globals
 * @returns process exit code — 0 on success, 1 on refusal/validation failure
 *   (cli.ts hands this to `deps.exit`; the command never calls exit itself).
 *   Async since the prompt became one: see {@link CommandDeps.prompt}.
 */
export async function runConfigure(opts: ConfigureOpts, deps: CommandDeps): Promise<number> {
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

  /**
   * Default for one key: the STORED value, else the built-in — in every mode,
   * interactive or not.
   *
   * `--yes`/non-TTY used to answer with the built-ins alone, which made a
   * scripted re-run a RESET of every key it was not given a flag for. That
   * contradicted `init`'s own idempotence contract, and it had a live victim:
   * the desktop console's save is a non-interactive `init --yes --port … --host
   * …`, so changing the port there repointed `DATABASE_PATH` at the config-dir
   * default and threw away a customised `APP_BASE_URL` — the one key someone
   * edits precisely because the default is wrong for their network. Flags
   * still outrank the file, so nothing a caller ASKS for is affected.
   */
  const dflt = (key: ConfigKey, builtin: string): string => existing[key] ?? builtin;
  /** Resolve one answer (flag > trimmed prompt/ENTER-default > default); null = EOF. */
  const ask = async (question: string, def: string, flag: string | undefined): Promise<string | null> => {
    if (flag !== undefined) return flag.trim();
    if (!interactive) return def;
    const answer = await deps.prompt(question, def);
    if (answer === null) return null;
    const trimmed = answer.trim();
    return trimmed === "" ? def : trimmed;
  };
  /**
   * Resolve + validate one owned key. Null means "aborted": the reason is
   * already on stderr (EOF notice or the validation message) and the caller
   * returns 1 — every question is validated the MOMENT it is answered, so an
   * interactive typo dies at that prompt, never after collecting the rest.
   *
   * The validation here is not a second set of rules: it is the same
   * `validateValue` {@link applyConfig} runs, called earlier so the person
   * typing gets told at the prompt that produced the mistake. `applyConfig`
   * re-checks everything anyway, which costs nothing and is what makes it safe
   * for `PATCH /api/admin/server/config`, where there are no prompts to
   * validate at.
   */
  const resolve = async (
    key: ConfigKey,
    question: string,
    def: string,
    flag: string | undefined,
  ): Promise<string | null> => {
    const value = await ask(question, def, flag);
    if (value === null) {
      deps.error("stdin closed before all answers were given. Nothing was written.");
      return null;
    }
    const invalid = validateValue(key, value);
    if (invalid) {
      // A value BYTE-IDENTICAL to what is already stored is preserved, not
      // refused, because preserving what the boot already reads grants
      // nothing new — and refusing it wedged the whole command.
      //
      // The reachable case was the documented escape hatch: `docs/security.md`
      // says an env var or a hand-edit bypasses this validator, so a wildcard
      // (which better-auth genuinely honours) can be in config.env. But the
      // desktop console seeds stored values and sends EVERY field on save, so
      // changing the port re-sent the stored wildcard, this refused it, and the
      // console could never save again — with nothing on the page explaining
      // it, since `status` is deliberately silent about wildcards. The same
      // shape blocked a hand-written unusable APP_BASE_URL.
      //
      // Only a CHANGED value has to satisfy the validator, so this is not an
      // escape: a newly typed wildcard is still refused. `applyConfig` keeps
      // the identical branch, and emits the identical warning.
      if (existing[key] === value) return value;
      deps.error(invalid);
      return null;
    }
    return value;
  };

  const port = await resolve("SERVER_PORT", "Server port", dflt("SERVER_PORT", "3080"), opts.port);
  if (port === null) return 1;
  const host = await resolve(
    "HOST",
    "Bind address. 0.0.0.0 serves the LAN (what remote nodes and devices need); type 127.0.0.1 to stay loopback-only",
    dflt("HOST", "0.0.0.0"),
    opts.host,
  );
  if (host === null) return 1;
  // The base-URL default follows the ANSWERED port (constants.ts derives it
  // from SERVER_PORT at boot too — mirrors each other) unless the file stores
  // one — then the stored URL is the default, unchanged.
  const baseUrl = await resolve(
    "APP_BASE_URL",
    "Public base URL (browsers and remote nodes dial this)",
    dflt("APP_BASE_URL", `http://localhost:${port}`),
    opts.baseUrl,
  );
  if (baseUrl === null) return 1;
  // The OTHER addresses a browser may dial this instance on. The phone on the
  // LAN needs none of this any more — `services/lan-origins.ts` derives this
  // machine's own interface addresses into the allowlist automatically — but
  // a NAME it is not answers to (a `.local` host, local DNS, a proxy domain)
  // still sends an `Origin` nothing matches and dies on 403 "Invalid origin".
  // This is the key that fixes that half, and it is asked here rather than
  // left to a hand-edit because nothing about the failure names it.
  // The question depends on whether there IS a stored list, because ENTER
  // means different things in the two cases and the prompt has to say which.
  // `ask` maps a blank answer to the default, and defaults follow the file — so
  // on a re-run ENTER rewrites the stored list verbatim. A question reading
  // "blank for none" therefore promised a clear that pressing ENTER does not
  // perform, and no interactive answer performs: clearing is
  // `--trusted-origins ""` (the one emptyable flag), which the prompt names
  // instead of implying a route that does not exist.
  const storedOrigins = dflt("TRUSTED_ORIGINS", "");
  const originsQuestion =
    storedOrigins === ""
      ? "Other addresses browsers will use (comma-separated origins; blank for none)"
      : 'Other addresses browsers will use (comma-separated origins; ENTER keeps the list shown, `--trusted-origins ""` clears it)';
  const trustedOrigins = await resolve("TRUSTED_ORIGINS", originsQuestion, storedOrigins, opts.trustedOrigins);
  if (trustedOrigins === null) return 1;
  const dbPath = await resolve(
    "DATABASE_PATH",
    "SQLite database file",
    dflt("DATABASE_PATH", join(deps.configDir, "subshell.db")),
    opts.dbPath,
  );
  if (dbPath === null) return 1;

  // ONE writer, shared with `PATCH /api/admin/server/config`: it validates
  // every answer, computes the two address warnings, and performs the atomic
  // preservation-preserving rewrite. Every answer is passed EXPLICITLY, even
  // one that equals the stored default, so the flow's own "defaults follow
  // the file" resolution is what decides the values, not applyConfig's.
  const result = applyConfig({ port, host, baseUrl, trustedOrigins, dbPath }, deps.configDir);
  if (!result.ok) {
    deps.error(result.reason);
    return 1;
  }
  for (const warning of result.warnings) deps.log(`warning: ${warning}`);
  deps.log(`wrote ${result.path} (0600)`);
  for (const key of OWNED_KEYS) deps.log(`  ${key} = ${result.values[key]}`);
  // Only when set: a line reading `TRUSTED_ORIGINS = ` invites the reader to
  // think an empty list was written, which is the one thing that never happens.
  if (result.values.TRUSTED_ORIGINS) deps.log(`  TRUSTED_ORIGINS = ${result.values.TRUSTED_ORIGINS}`);
  deps.log("restart the server (or start it with: subshell-server) to apply.");
  return 0;
}
