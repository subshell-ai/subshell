import { shellQuote } from "./shell.js";

/**
 * The shell command a pane's `pane-died` hook runs.
 *
 * `#{pane_dead_status}` is tmux's own interpolation, quoted so an empty status
 * still arrives as an argument rather than vanishing from the argv — that is
 * what lets the reporter tell "no status" from "exited 0".
 *
 * @param reporter - the host-resolved prefix that re-enters this binary, or
 *                   undefined when none could be resolved
 * @returns the command, or undefined to register no hook at all
 */
export function exitHookFor(
  reporter: { command: string; args: string[] } | undefined,
  subshellEnv: Record<string, string>,
): string | undefined {
  if (!reporter) return undefined;
  // The reporter's credentials must ride the COMMAND, because the tmux server
  // does not have them. The pane is launched through `env -i …` (see
  // `assembleHarnessCommand`), so the subshell's `SUBSHELL_*` reach that
  // process alone — the server tmux itself was started with none of them, and
  // a `run-shell` hook inherits the server's environment, not the pane's.
  // Measured 2026-09-20: `show-environment` on a live subshell's socket lists
  // no `SUBSHELL_ID` at all, and a hook without one is a silent no-op.
  //
  // Carried here rather than by `set-environment` on the session so no new
  // tmux state holds the token: the exposure is the same class either way
  // (the local user already reads it from the pane's argv via `ps`, which
  // `docs/security.md` records), but this keeps it to the one place it is
  // used.
  const creds = REPORTER_ENV_KEYS.filter((k) => subshellEnv[k] !== undefined).map(
    (k) => `${k}=${shellQuote(subshellEnv[k] as string)}`,
  );
  // Without a full set the report cannot authenticate, so register nothing and
  // let the sweep be the answer — exactly as a plugin omits hooks it cannot
  // build a command for.
  if (creds.length !== REPORTER_ENV_KEYS.length) return undefined;
  // `reporter.args` ALREADY ends with the `report` subcommand — the spec is a
  // prefix "ready for a plugin's own verb words to be appended", so only the
  // verb and its argument go here. Appending `report` again produced
  // `report report exit`, a usage error the hook swallowed silently.
  //
  // EVERY word is quoted except the last, exactly as `assembleHarnessCommand`
  // and the plugins' own `reporterHook` do. The reporter's command is a real
  // path on this machine and paths have spaces in them: `process.execPath`
  // inside a macOS bundle is `…/Subshell Server.app/Contents/MacOS/…`, which
  // unquoted splits into two words and makes the hook a silent no-op — no
  // output, no exit code anyone sees, and the death falls back to the sweep.
  // Demonstrated in review against a real tmux server.
  //
  // The status is the ONE word left bare: those single quotes are literal
  // text for tmux to interpolate `#{pane_dead_status}` inside, so quoting
  // them would escape the quotes and pass the format string through verbatim.
  const words = [
    "env",
    ...creds,
    ...[reporter.command, ...reporter.args, "exit"].map(shellQuote),
    "'#{pane_dead_status}'",
  ];
  return words.join(" ");
}

/** Exactly what `readMcpEnv` needs to authenticate a report, and nothing more. */
const REPORTER_ENV_KEYS = ["SUBSHELL_API_KEY", "SUBSHELL_BASE_URL", "SUBSHELL_ID"] as const;
