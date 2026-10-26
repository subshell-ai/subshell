import { join } from "node:path";
import { type ApplyConfigInput, applyConfig, readExistingConfig } from "@/modules/server/config/apply.js";
import { type TmuxOffer, TmuxPreflightDeps, tmuxPreflight } from "@/modules/server/tmux-preflight.js";
import { type ConfigKey, OPTIONAL_KEYS, OWNED_KEYS, validateValue } from "../../modules/server/config/values.js";

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
 * `data/subshell.db` because `@/modules/auth/auth.js` opened it at import — is gone with
 * the eager construction that caused it, and `src/cli/__tests__/cli-entry.test.ts`
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
   * `cli/dispatch.ts`); the union still accepts the plain function every test injects,
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
   * offer flow without touching a real installer. The `stdin` argument is
   * the terminal fd to prompt on (see {@link ttyFd}); production callers
   * that leave it unset inherit.
   */
  spawnInstall?: (argv: readonly string[], stdin?: number) => number;
  /**
   * The attached terminal's fd when `init` swapped a piped run onto the
   * controlling tty (2026-09-26). The tmux offer hands it to an installer
   * child so Homebrew's admin password can be typed on the real terminal;
   * absent for direct TTY runs and every other command.
   */
  ttyFd?: number;
}

/**
 * The config flows' ONE offer bundle: `init` and `configure` gate
 * identically (ask on a TTY, install on `--yes`, refuse and name the remedy
 * otherwise), and both take it from here so the gate cannot drift between
 * the two commands. Platform is NOT part of the offer — it rides on
 * {@link TmuxPreflightDeps.platform} where the preflight also resolves the
 * hint text from, one source for both. The command NAME rides in so the
 * remedy line sentencizes itself truthfully per command, and the attached
 * tty fd rides in so an installer child can be PROMPTED on it when fd 0 is
 * still the drained pipe.
 */
export function makeTmuxOffer(
  opts: ConfigureOpts,
  deps: CommandDeps,
  commandName: "init" | "configure",
  installPath?: string,
): TmuxOffer {
  return {
    interactive: !opts.yes && deps.isTTY,
    autoAccept: opts.yes === true,
    terminal: deps.isTTY,
    commandName,
    // The declined/aborted message for a run that COULD have asked: name the
    // terminal remedy (or the --yes one), and say to rerun once tmux exists.
    declineNotice:
      opts.yes || deps.isTTY
        ? undefined
        : `tmux not installed; re-run ${commandName} in a terminal (or with --yes) to install it`,
    rerunNote:
      `Subshell Server needs tmux to run panes, and this run stopped before writing anything else; ` +
      `subshell-server itself is already installed${installPath ? ` at ${installPath}` : ""}. ` +
      `Once tmux is present, rerun: subshell-server ${commandName}`,
    log: deps.log,
    prompt: deps.promptSync,
    spawn: deps.spawnInstall,
    stdin: deps.ttyFd,
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
   * `--verbose` (2026-09-26): CONSOLE debug for this run, refused alongside
   * `--json` wherever a command emits JSON. Read by the DISPATCH, which
   * raises the transport gate; the verbs themselves never branch on it, so
   * what gets written is identical with and without the flag.
   */
  verbose?: boolean;
  /**
   * `--service` / `--no-service` (`init` only): install the background
   * service, or do not. Absent means "ask, and take yes when nobody can be
   * asked" — the opt-out exists for scripts and for the desktop apps, which
   * install the service themselves with their own autostart choice.
   */
  service?: boolean;
}

/** The body fields {@link ApplyConfigInput} carries, paired with the key each one writes. */
const _INPUT_FIELD_FOR_KEY = {
  SERVER_PORT: "port",
  HOST: "host",
  APP_BASE_URL: "baseUrl",
  DATABASE_PATH: "dbPath",
  TRUSTED_ORIGINS: "trustedOrigins",
} as const satisfies Record<ConfigKey, keyof ApplyConfigInput>;

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
  // may fire only here (spec 2026-09-03, widened 2026-09-26: `--yes` now
  // auto-installs instead of keeping the refusal; a non-TTY without `--yes`
  // keeps the refusal AND names the remedy).
  const interactive = !opts.yes && deps.isTTY;
  if (!tmuxPreflight({ ...deps, offer: makeTmuxOffer(opts, deps, "configure") })) return 1;

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
  // LAN needs none of this any more — `modules/network/lan-origins.ts` derives this
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
