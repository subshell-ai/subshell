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
  const creds = REPORTER_ENV_KEYS.filter((k) => usableCredential(subshellEnv[k])).map(
    (k) => `${k}=${shellQuote(subshellEnv[k] as string)}`,
  );
  // Without a full set the report cannot authenticate, so register nothing and
  // let the sweep be the answer — exactly as a plugin omits hooks it cannot
  // build a command for. A value this builder cannot carry safely (below) is
  // treated as a missing one, deliberately: the sweep is a correct backstop
  // and a corrupted credential is not.
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

/**
 * Characters a credential cannot carry through a `set-hook` value.
 *
 * **This is two quoting layers, and only one of them is ours.** The string is
 * shell-quoted here, then stored as a tmux hook and RE-PARSED by tmux's own
 * command parser when the pane dies — so `shellQuote`'s `'\''` escape passes
 * through tmux's quote and backslash rules before any shell sees it. Measured
 * end to end on 2026-09-20, one real pane death per value:
 *
 * - a `'` in the value: `set-hook` returns 0 and the hook **silently never
 *   fires**;
 * - a `\`: the hook fires with a **corrupted** value, so the report POSTs and
 *   401s — worse than not firing, because it looks like it worked;
 * - a `#`: tmux EXPANDS it. `#{...}` reads tmux state and `#(...)` is command
 *   substitution tmux runs, so this position is a format context rather than
 *   an inert string.
 *
 * A `"` closes the `run-shell "…"` context these are spliced into.
 *
 * Not theoretical: a preset may legitimately override `SUBSHELL_BASE_URL`
 * (`paneEnvFor`), so one of these three values is user-authored.
 *
 * The obvious probe says "safe" and is at the wrong layer: `tmux run-shell
 * "…'ab'\''cd'…"` typed at a shell works, because the SHELL split the argv
 * and tmux never re-parsed it. Only set-hook-then-fire exercises the parser
 * this code actually goes through.
 */
const UNSAFE_IN_HOOK = /['"\\#]/;

/** Whether a credential value survives the two quoting layers between here and the pane's death. */
function usableCredential(value: string | undefined): value is string {
  return value !== undefined && !UNSAFE_IN_HOOK.test(value);
}

/** Exactly what `readMcpEnv` needs to authenticate a report, and nothing more. */
const REPORTER_ENV_KEYS = ["SUBSHELL_API_KEY", "SUBSHELL_BASE_URL", "SUBSHELL_ID"] as const;
