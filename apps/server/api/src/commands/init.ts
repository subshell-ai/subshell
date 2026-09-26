import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { isLoopbackUrl } from "@/commands/config-values.js";
import {
  type CommandDeps,
  type ConfigureOpts,
  ensureConfigDir,
  makeTmuxOffer,
  readExistingConfig,
  runConfigure,
  tmuxPreflight,
  writeConfigEnv,
} from "@/commands/configure.js";
import {
  addLocalBinToProfiles,
  LOCAL_BIN_EXPORT,
  localBinDir,
  localBinOnPath,
  type ProfileOutcome,
} from "@/commands/shell-profile.js";
import type { CliResult } from "@/service.js";

/**
 * `subshell-server init` — first-run bootstrap of the config home:
 * ensure `<configDir>` (0700) and a `BETTER_AUTH_SECRET` in `config.env`
 * (generated exactly once, 32 random bytes as base64url), then run the
 * ordinary configure flow with the same flags.
 *
 * Secret resolution ladder (the value actually PERSISTED to config.env):
 * a non-empty key already in the file wins (never regenerated — idempotence,
 * the whole point of running init twice), else a non-empty `BETTER_AUTH_SECRET`
 * in the environment is adopted and persisted (so a systemd
 * `EnvironmentFile=<configDir>/config.env` boot keeps working without the
 * var), else a fresh one is generated. The file's own value is re-written
 * only when it was absent/empty — an existing secret is left byte-identical
 * and configure merely carries it forward.
 *
 * Since spec 2026-09-15 it is the whole SETUP SEQUENCE rather than the config
 * write alone: after the configure flow it asks about the background service,
 * installs it through the same `installService` that `service install` calls,
 * and prints the handoff that says where to create the admin account. A
 * headless operator had every one of those verbs already and no sequence
 * pointing at them, which is the defect this closes.
 *
 * Since spec 2026-09-26 it also OWNS THE TERMINAL (cli.ts acquires it before
 * this function ever runs) and it owns two questions the installer script used
 * to echo as notes: the tmux install (via the shared preflight's `--yes`
 * route) and the `~/.local/bin` PATH export. The rule the wave exists for:
 * every question is either ASKED (terminal), ANSWERED YES (`--yes`), or
 * PRONOUNCED (`not interactive:` on every default a silent run took).
 */

/** Seams `init` needs beyond the configure flow's own (see {@link CommandDeps}). */
export interface InitDeps extends CommandDeps {
  /**
   * Installs the background service with autostart armed. Production wires
   * the SAME `installService` that `service install` drives, so the two ways
   * into a backgrounded server cannot install different things.
   *
   * Required rather than optional, deliberately: an absent seam would make
   * "silently skip the service" the outcome of a wiring mistake, and this
   * question's default is yes.
   */
  installService: () => CliResult;
  /**
   * This host's own name, for the line that says which address other machines
   * will use (production: `os.hostname()`).
   */
  hostname?: () => string;
  /**
   * Home the PATH question hangs off (production: `homedir()`): the user's
   * `~/.local/bin` is what gets offered, and `~/.zprofile`/`~/.zshrc` are
   * where the fix lands. Absent (tests that pin neither) means the PATH offer
   * is skipped entirely — a wiring mistake cannot make `init` write a profile
   * it was never pointed at.
   */
  home?: string;
}

/** The config values the handoff reads back — see {@link setupHandoffLines}. */
export interface HandoffDeps {
  /** The config home whose `config.env` was just written. */
  configDir: string;
  /** This host's own name (production: `os.hostname()`). */
  hostname?: () => string;
}

/**
 * The sentences a person sees at the end of the command that set this server
 * up: where to create the admin account, and — on the one configuration whose
 * only symptom is a 403 naming nothing — which address other machines will
 * actually type and what makes it work.
 *
 * Shared by `init` and by `service install`, because those are the two
 * commands an operator ends on and the two must not say different things.
 *
 * Read from the FILE rather than from `process.env` or from the answers: the
 * file is what the next boot reads, so it is the only source that cannot
 * promise an address the server will not serve. An unreadable one falls back
 * to the built-in defaults rather than refusing — this is the closing line of
 * a command that already succeeded.
 */
export function setupHandoffLines(deps: HandoffDeps): string[] {
  let stored: Record<string, string> = {};
  try {
    stored = readExistingConfig(deps.configDir);
  } catch {
    // Defaults below; a closing sentence is not worth failing a written config.
  }
  const port = stored.SERVER_PORT ?? "3080";
  const host = stored.HOST ?? "0.0.0.0";
  const baseUrl = stored.APP_BASE_URL ?? `http://localhost:${port}`;
  const lines = [`Open ${baseUrl}/setup in a browser to create the admin account.`];
  // A wildcard bind serves the LAN, and the machine's OWN addresses are
  // derived into the allowlist (`lan-origins.ts`) — an IP spelling needs no
  // act. A NAME is not an interface address, and a hostname is exactly what a
  // person at a second machine types, so the handoff still names it, now with
  // the flag that makes it work.
  if (host === "0.0.0.0" && isLoopbackUrl(baseUrl)) {
    const origin = `http://${(deps.hostname ?? hostname)()}:${port}`;
    lines.push(
      "From another machine, this server's LAN address signs in with no setup. By name it is " +
        `${origin}. Add that first (subshell-server configure --trusted-origins ${origin}), ` +
        `or signing in by name answers 403 "Invalid origin".`,
    );
  }
  return lines;
}

/** 32 random bytes → 43 base64url chars (the plan's "48-char base64url" is the same construction). */
function generateAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Run init: tmux preflight → mkdir 0700 home → secret bootstrap → configure
 * flow → the PATH offer → the service question → the handoff.
 *
 * @param opts - parsed flags, passed through to `runConfigure` verbatim
 * @param deps - injected seams (see {@link InitDeps})
 * @returns process exit code (0 ok, 1 refusal/validation/install failure);
 *   cli.ts maps it to `deps.exit`
 */
export async function runInit(opts: ConfigureOpts, deps: InitDeps): Promise<number> {
  // BEFORE every write AND every other question — including the config home
  // itself (2026-09-26 ruling: a declined or failed tmux install ABORTS init
  // with nothing written). One shared offer bundle with runConfigure
  // (makeTmuxOffer) — the gate cannot drift between commands.
  const installedBinaryHint = deps.home === undefined ? undefined : join(localBinDir(deps.home), "subshell-server");
  if (!tmuxPreflight({ ...deps, offer: makeTmuxOffer(opts, deps, "init", installedBinaryHint) })) return 1;

  ensureConfigDir(deps.configDir);

  let existing: Record<string, string>;
  try {
    existing = readExistingConfig(deps.configDir);
  } catch (err) {
    deps.error(`subshell-server: cannot read ${deps.configDir}/config.env: ${(err as Error).message}`);
    return 1;
  }

  const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v : undefined);
  const fileSecret = nonEmpty(existing.BETTER_AUTH_SECRET);
  if (fileSecret !== undefined) {
    deps.log("BETTER_AUTH_SECRET already set in config.env, left untouched");
  } else {
    const fromEnv = nonEmpty(deps.env.BETTER_AUTH_SECRET);
    const secret = fromEnv ?? generateAuthSecret();
    try {
      writeConfigEnv(deps.configDir, { ...existing, BETTER_AUTH_SECRET: secret });
    } catch (err) {
      deps.error(`subshell-server: cannot write ${deps.configDir}/config.env: ${(err as Error).message}`);
      return 1;
    }
    deps.log(
      fromEnv !== undefined
        ? "BETTER_AUTH_SECRET taken from the environment, persisted to config.env"
        : "BETTER_AUTH_SECRET generated (32 random bytes, base64url) and written to config.env (0600)",
    );
  }

  const code = await runConfigure(opts, deps);
  if (code !== 0) return code;

  await offerPathOnLoginShell(opts, deps);
  if (await wantsService(opts, deps)) {
    const result = deps.installService();
    // VERBATIM, out and err alike: on Linux this output carries the linger
    // hint, which is the one line deciding whether a reboot keeps the server.
    if (result.out !== "") deps.log(result.out.replace(/\n+$/, ""));
    if (result.err !== "") deps.error(result.err.replace(/\n+$/, ""));
    // No handoff after a failed install: pointing someone at a URL nothing is
    // listening on is worse than saying nothing.
    if (result.code !== 0) return result.code;
  }

  for (const line of setupHandoffLines(deps)) deps.log(line);
  return 0;
}

/**
 * The PATH question, in the place the installer script's one-way note used
 * to sit (spec 2026-09-26). The same three-way rule as every other question
 * here: `--yes` answers yes, a terminal gets the question, and a run with
 * neither makes no unasked write — it prints the manual instructions (the
 * words of the old script note) instead, because the whole defect this wave
 * closes is SILENCE about what a piped run decided alone.
 *
 * `home` absent means the seam was never wired (unit suites that pin neither
 * PATH nor profiles) and `PATH` absent means there is no PATH to inspect:
 * either way the offer is skipped rather than guessed at.
 */
async function offerPathOnLoginShell(opts: ConfigureOpts, deps: InitDeps): Promise<void> {
  if (deps.home === undefined) return;
  const onPath = localBinOnPath(deps.env.PATH, deps.home);
  if (onPath !== false) return;
  const binDir = localBinDir(deps.home);
  if (opts.yes) {
    reportPathWrite(deps, addLocalBinToProfiles(deps.home));
    return;
  }
  if (deps.isTTY) {
    const answer = await deps.confirm(`Add ${binDir} to your PATH (writes an export line to ~/.zprofile)?`, true);
    if (answer === true) reportPathWrite(deps, addLocalBinToProfiles(deps.home));
    // A cancel reads as "not that part", the same reading the service
    // question gives it: the config is already written and init is idempotent.
    return;
  }
  deps.log(`not interactive: ${binDir} is not on your PATH. Add it to ~/.zprofile with:`);
  deps.log(`    ${LOCAL_BIN_EXPORT}`);
}

/** One line per file the PATH write touched, so the user sees the file names. */
function reportPathWrite(deps: InitDeps, result: { zprofile: ProfileOutcome; zshrc: ProfileOutcome }): void {
  const label: Record<Exclude<ProfileOutcome, "absent">, string> = {
    created: "created ~/.zprofile with the ~/.local/bin export",
    appended: "added the ~/.local/bin export to ~/.zprofile",
    "already-present": "~/.zprofile already lists ~/.local/bin on PATH",
  };
  const zprofileLine = `PATH: ${label[result.zprofile]}`;
  if (result.zshrc === "appended") deps.log(`${zprofileLine}; also appended it to ~/.zshrc`);
  else deps.log(zprofileLine);
}

/**
 * Whether to install the background service.
 *
 * The same three-way rule as every other question here, updated by the
 * operator ruling of 2026-09-26: a flag decides, `--yes` means YES (a server
 * that dies with the SSH session is not what anyone meant by "set this up"),
 * a terminal is ASKED. The silent case changed: a run with NO terminal and no
 * `--yes` does NOT install — `init` attaches its own terminal now (the piped
 * interview runs wherever a tty exists), so what lands here genuinely has
 * nobody to ask, and it makes no unasked system change. It prints the default
 * it took instead: silence about the decision was the bug. A CANCEL on the
 * question is "not that part": config.env is already written and `init` is
 * idempotent, so failing the command would throw away work the person did not
 * ask to undo.
 */
async function wantsService(opts: ConfigureOpts, deps: InitDeps): Promise<boolean> {
  if (opts.service !== undefined) return opts.service;
  if (opts.yes) {
    deps.log("registering background service…");
    return true;
  }
  if (!deps.isTTY) {
    deps.log(
      "not interactive: background service NOT installed (run: subshell-server service install to add it, or re-run init in a terminal)",
    );
    return false;
  }
  const answer = await deps.confirm("Run Subshell Server in the background and start it at login?", true);
  return answer === true;
}
