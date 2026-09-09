import { randomBytes } from "node:crypto";
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
 * Sync-by-contract like configure itself (cli.ts invariant 1): the boot
 * graph must never evaluate on this path.
 */

/** 32 random bytes → 43 base64url chars (the plan's "48-char base64url" is the same construction). */
function generateAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Run init: tmux preflight → mkdir 0700 home → secret bootstrap → configure flow.
 *
 * @param opts - parsed flags, passed through to `runConfigure` verbatim
 * @param deps - injected seams (see `CommandDeps`)
 * @returns process exit code (0 ok, 1 refusal/validation failure); cli.ts
 *   maps it to `deps.exit`
 */
export function runInit(opts: ConfigureOpts, deps: CommandDeps): number {
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

  return runConfigure(opts, deps);
}
