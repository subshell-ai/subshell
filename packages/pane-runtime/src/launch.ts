import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { shellQuote } from "./shell.js";
import type { HarnessPlugin, McpRegistration, ProfileDefinition } from "./types.js";

/**
 * POSIX shell variable names: a leading letter/underscore then word chars.
 * Anything else (spaces, `;`, newlines, `#`, …) would splice raw shell into
 * the pane command, because tmux executes the assembled string via `sh -c`.
 */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds the shell command tmux runs for a harness subshell. Env precedence,
 * lowest to highest: curated host env (`curatedEnv()`) < SUBSHELL_* credentials <
 * profile env < the MCP registration's wiring env (see the inline note — the
 * wiring layer wins on purpose). The harness argv itself is built by the
 * plugin, but the final assembly IS a shell string (tmux runs it through
 * `sh -c`), so every env KEY is validated against {@link ENV_KEY_RE} and
 * every value is single-quoted: an unchecked key like `X; touch /tmp/pwned #`
 * would execute during that `sh -c`, before `env -i` ever scrubs anything —
 * and it would inherit the tmux server's env (seeded from the backend
 * process). Values from any source may contain shell metacharacters; keys
 * may not, so a bad key is a hard error, not a quoting problem.
 * Local launcher (backend) and remote agents (subshell) assemble pane
 * commands through this exact function — byte-identity is the spec (§6.4).
 * @throws Error when a merged env key is not a valid shell variable name
 * (names the offending key). Subshell creation surfaces it to the caller.
 */
export function buildHarnessCommand(
  harness: HarnessPlugin,
  binary: string,
  cwd: string,
  profile: ProfileDefinition,
  subshellName: string,
  subshellEnv: Record<string, string> = {},
  mcp?: McpRegistration,
  harnessSession?: { id: string; mode: "start" | "resume" },
): string {
  const argv = harness.buildCommand({ binary, cwd, profile, subshellName, mcp, harnessSession });
  return assembleHarnessCommand(argv, profile, subshellEnv, mcp?.env);
}

/**
 * Assembles the `env -i` shell string around a FINAL argv — the entire body of
 * {@link buildHarnessCommand} after `harness.buildCommand`. Split out so an
 * argv that arrives already built (the `launch` frame's server-built argv,
 * inversion spec §5) assembles through the identical env rules: extracting
 * this IS the byte-identity, for a command line this machine never built.
 *
 * @param argv the complete, already-resolved command line (no placeholder left)
 * @param profile the wire profile (its `env` layer rides above `subshellEnv`)
 * @param subshellEnv SUBSHELL_* credentials from the control plane
 * @param mcpEnv the MCP registration's wiring env (highest layer; see below)
 * @throws Error when a merged env key is not a valid shell variable name
 */
export function assembleHarnessCommand(
  argv: string[],
  profile: ProfileDefinition,
  subshellEnv: Record<string, string> = {},
  mcpEnv?: Record<string, string>,
): string {
  // Precedence, lowest to highest: curated host env < SUBSHELL_* credentials
  // (a profile may deliberately override SUBSHELL_BASE_URL) < the profile's own
  // env < the registration's wiring env. Wiring env goes LAST on purpose:
  // a key like OPENCODE_CONFIG is transport plumbing, not a user knob — a
  // profile setting it would otherwise silently drop the subshell's subshell
  // tools while the UI still promised automatic registration.
  const env = { ...curatedEnv(), ...subshellEnv, ...profile.env, ...(mcpEnv ?? {}) };
  // Defense-in-depth at the last chokepoint before the shell string exists:
  // this catches legacy DB rows and any other env source merged above,
  // regardless of what the entry-point (profile-save) validation allowed.
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid harness env var name ${JSON.stringify(key)}: keys must match [A-Za-z_][A-Za-z0-9_]*`);
    }
  }
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(String(v))}`);
  // TERM must always reach the harness — pane programs decide color support
  // from it, and a backend started by systemd/docker has none (its own
  // terminal type would describe the wrong terminal even when set). The
  // value that describes THIS terminal is the one tmux gave the pane, so
  // emit a literal "$TERM": the `sh -c` wrapper expands it at launch time,
  // inside the pane. A profile that sets TERM explicitly wins instead.
  if (!("TERM" in env)) envArgs.push('TERM="$TERM"');
  return `env -i ${envArgs.join(" ")} ${argv.map(shellQuote).join(" ")}`;
}

/** The minimal host env we pass through to harness processes. */
export function curatedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  // TERM deliberately absent: the SERVER's terminal type describes the wrong
  // terminal (see buildHarnessCommand — the pane's own TERM is forwarded).
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key]) out[key] = process.env[key];
  }
  // Claude Code needs to find its own install dir even if PATH is trimmed.
  out.CLAUDE_PATH = process.env.CLAUDE_PATH ?? "";
  return out;
}

/** Validates + resolves the working directory; rejects non-directories. */
export async function validateWorkingDir(raw: string): Promise<string> {
  if (!raw || typeof raw !== "string") throw new Error("workingDir is required");
  const resolved = resolve(raw);
  if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
  if (!(await isDirectory(resolved))) throw new Error(`Not a directory: ${resolved}`);
  return realpathSync(resolved);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await Bun.file(p).stat();
    return stat.isDirectory();
  } catch {
    return false;
  }
}
