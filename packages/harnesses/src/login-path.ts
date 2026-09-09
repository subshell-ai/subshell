import { userInfo } from "node:os";
import { readCommandBounded } from "./bounded-exec.js";

/**
 * The PATH a SERVICE does not have.
 *
 * `subshell-server service install` bakes `Environment=PATH=` from the
 * installing process's PATH, so the running service sees whatever shell
 * happened to install it — permanently. That is fine for tmux, which the
 * install preflights, and wrong for harness binaries, which are found later
 * and reported as "not installed" when they are merely not on that PATH.
 *
 * Measured here (2026-09-09): the installed unit's PATH carried `~/.cargo/bin`
 * and `~/.deno/bin` but no nvm entry, while `claude` lived at
 * `~/.nvm/versions/node/v22.6.0/bin/claude` — the official npm install route.
 * The console reported claude-code as not installed while running inside it.
 *
 * A static list of well-known paths cannot fix that class: nvm's directories
 * carry a node VERSION, and fnm, volta, asdf and n each have their own shape.
 * The PATH the user actually installed with is the one their shell gives them,
 * so that is what this asks for. It is the same mechanism, and the same
 * reasoning, as `crates/desktop-core/src/shell_env.rs` uses for the desktop
 * app; that module's own docstring describes this bug.
 *
 * **It runs the user's login profile**, which is arbitrary code — as the
 * desktop app already does on every launch. No privilege is crossed: it is the
 * same OS user the server already runs as and whose binaries it already
 * execs. It is bounded and resolved at most once per process, and it is the
 * LAST rung of {@link findBinaryWithOptions}, so a harness found on PATH or at
 * a known location never pays for it.
 */

/** How long the probe may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 4000;

/** Resolved at most once per process; `null` until probed, `[]` on failure. */
let cached: string[] | null = null;

/**
 * The user's login shell, from the password database rather than `$SHELL`.
 *
 * A service is not started from a shell, so `$SHELL` is whatever systemd or
 * launchd happened to pass — frequently nothing.
 */
function loginShell(): string {
  try {
    const shell = userInfo().shell;
    if (shell?.startsWith("/")) return shell;
  } catch {
    // A container without a passwd entry for this uid; fall through.
  }
  return "/bin/sh";
}

/**
 * PATH entries from a login shell, empty when it cannot be asked.
 *
 * Cached, so the profile runs at most once per process.
 */
export async function loginPathEntries(): Promise<string[]> {
  if (cached !== null) return cached;
  cached = await probe();
  return cached;
}

/**
 * Drops the cached probe. For tests only.
 * @internal
 */
export function resetLoginPathForTests(): void {
  cached = null;
}

async function probe(): Promise<string[]> {
  // A profile that blocks (a prompt, a network call, a backgrounded job) must
  // not wedge the caller: this is a diagnostic, and an empty answer is a fine
  // one. `readCommandBounded` races the read rather than only killing the
  // process, which matters here more than anywhere: a login profile is exactly
  // the kind of script that leaves a child holding stdout, and killing the
  // shell would then never end the read.
  const result = await readCommandBounded([loginShell(), "-l", "-c", 'printf %s "$PATH"'], PROBE_TIMEOUT_MS);
  // No shell, no spawn permission, a timeout, or a profile that failed. Not an
  // error worth raising: the caller has already tried PATH, the known
  // locations and the version-manager layouts.
  if (result?.exitCode !== 0) return [];
  return result.text
    .trim()
    .split(":")
    .filter((entry) => entry.length > 0);
}
