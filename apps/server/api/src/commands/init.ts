import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
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
 * flow → the service question → the handoff.
 *
 * @param opts - parsed flags, passed through to `runConfigure` verbatim
 * @param deps - injected seams (see {@link InitDeps})
 * @returns process exit code (0 ok, 1 refusal/validation/install failure);
 *   cli.ts maps it to `deps.exit`
 */
export async function runInit(opts: ConfigureOpts, deps: InitDeps): Promise<number> {
  // BEFORE any write — including the config home itself: a refused init on a
  // machine without tmux must leave no trace. One shared offer bundle with
  // runConfigure (makeTmuxOffer) — the gate cannot drift between commands.
  if (!tmuxPreflight({ ...deps, offer: makeTmuxOffer(opts, deps) })) return 1;

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
 * Whether to install the background service.
 *
 * One rule, and it is the same one `--yes` follows everywhere here: a flag
 * decides, otherwise the question is asked, otherwise the default is taken —
 * and this default is YES, because a server that dies with the SSH session is
 * not what anyone meant by "set this up". A CANCEL is read as "not that
 * part": config.env is already written and `init` is idempotent, so failing
 * the command would throw away work the person did not ask to undo.
 */
async function wantsService(opts: ConfigureOpts, deps: InitDeps): Promise<boolean> {
  if (opts.service !== undefined) return opts.service;
  if (opts.yes || !deps.isTTY) return true;
  const answer = await deps.confirm("Run Subshell Server in the background and start it at login?", true);
  return answer === true;
}
