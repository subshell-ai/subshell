import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DetectionResult } from "@subshell-ai/plugin-api";
import { loginPathEntries } from "./login-path.js";
import { versionManagerBins } from "./version-manager-paths.js";

export interface BinaryLookupOptions {
  /** Environment to inspect (defaults to process.env; injectable for tests) */
  env?: Record<string, string | undefined>;
  /** Override for PATH lookup */
  pathEntries?: string[];
}

/**
 * The detection vocabulary is the CONTRACT's, not this module's.
 *
 * It was defined here and again in `@subshell-ai/plugin-api`, which is the
 * same structural-typing trap as the rest of that duplication: two unions
 * compile against each other happily right up until one gains a member. The
 * distinction they carry is the point of them, and it belongs in one place:
 * `override-invalid` is a mistake the operator can fix in one edit,
 * `not-on-path` is a missing install, and `no-binary` is a plugin that never
 * wanted one. Collapsing those into `null` is how a bad `CLAUDE_PATH` came to
 * be answered with an install command that cannot help.
 */
export type { DetectionReason, DetectionResult } from "@subshell-ai/plugin-api";

/**
 * Cross-platform-ish binary lookup, reporting why when it fails:
 *   1. `env[ENV_NAME]` (explicit override, e.g. CLAUDE_PATH) — `~/` expands
 *      against HOME; an absolute value answers, a broken PATH-like value
 *      (relative, unresolvable tilde) refuses with `override-invalid`, and a
 *      bare name is no pointer and falls through to rung 2
 *   2. `which`-style scan of PATH entries
 *   3. A couple of well-known install locations (resolved against HOME)
 *   4. Version-manager layouts, by glob (nvm, fnm, volta, asdf, mise, n)
 *   5. The LOGIN SHELL's PATH, as a last resort
 *
 * Rungs 4 and 5 both exist for one case that rungs 2 and 3 cannot answer: a
 * harness installed through a node version manager. A service's PATH is baked
 * at install time from whichever shell installed it, and nvm's bin directory
 * carries a node VERSION, so neither the running PATH nor any static list can
 * name it.
 *
 * Rung 4 is the one that actually answers it, by globbing the manager layouts;
 * `version-manager-paths.ts` records why a login shell cannot. Rung 5 stays
 * because it still covers managers with no predictable layout, and it is last
 * because it is the only rung that runs a user's profile. See
 * {@link loginPathEntries}, which is bounded and cached.
 */
export async function detectBinaryWithOptions(
  name: string,
  envName: string,
  knownPaths: string[],
  options: BinaryLookupOptions,
): Promise<DetectionResult> {
  const env = options.env ?? process.env;
  const explicit = expandHome(env[envName], env.HOME ?? homedir());
  if (explicit) {
    // A bare name says no WHERE, and real environments carry them (`SHELL=bash`
    // in containers): the rung is a pointer or it is nothing, so a slash-less
    // value falls through to the PATH scan that finds the binary honestly.
    // Anything ELSE the operator wrote was an attempt at a pointer, and an
    // attempt that does not resolve is an answer, not a hint — searching past
    // it would hide their mistake, which is what `override-invalid` exists to
    // prevent. Two shapes fail closed here rather than being silently ignored:
    // a RELATIVE path (`isExecutable` would test it against THIS process's
    // cwd, and a hit would bake a relative argv token that tmux later execs
    // against the PANE's directory — a different file, or an exec failure at
    // launch instead of detection), and an unexpandable `~user/...` (a
    // systemd `Environment=` line never expands tildes; silently ignoring the
    // pin would resolve a different build forever, silently).
    if (isAbsolute(explicit)) {
      if (await isExecutable(explicit)) return { path: explicit };
      return { path: null, reason: "override-invalid" };
    }
    if (explicit.includes("/")) return { path: null, reason: "override-invalid" };
  }

  const pathEntries = options.pathEntries ?? (env.PATH ?? "").split(":");
  for (const dir of pathEntries) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return { path: candidate };
  }

  const home = env.HOME ?? homedir();
  for (const rel of knownPaths) {
    const candidate = join(home, rel);
    if (await isExecutable(candidate)) return { path: candidate };
  }

  // Version managers, by glob. This runs even when a caller injected
  // `pathEntries`, unlike the login rung below, and the difference is
  // principled: this rung resolves entirely against the HOME it was given, so
  // it leaks nothing about the machine the test happens to run on.
  for (const dir of await versionManagerBins(home)) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return { path: candidate };
  }

  // Last: ask the user's shell where their tools are. Skipped entirely when a
  // caller injected `pathEntries`, because that caller is describing the world
  // it wants searched (every test does) and a real shell would leak this
  // machine's own PATH into it.
  if (!options.pathEntries) {
    for (const dir of await loginPathEntries()) {
      if (pathEntries.includes(dir)) continue;
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) return { path: candidate };
    }
  }

  return { path: null, reason: "not-on-path" };
}

/**
 * {@link detectBinaryWithOptions} against the live process env.
 *
 * **`pathEntries` is deliberately NOT set here**, even though this function
 * knows exactly what it would contain. That key means "the caller is
 * describing the world it wants searched", and it is what suppresses the
 * login-shell rung. Setting it from `process.env.PATH` looks like a harmless
 * shortcut and is not: an array is truthy, so it made the login rung
 * unreachable from every production caller while that rung's own test, which
 * omits the key, kept passing. The service-PATH bug it was added to fix was
 * therefore still live after the fix landed. Let the derivation happen inside.
 *
 * **A missing `SHELL` is filled from the passwd entry, but only here.**
 * Service managers start units with a stock env; the ones this repo writes
 * add `PATH` and nothing else, so `SHELL` is ABSENT in every
 * systemd/launchd-run server and node agent. For the terminal plugin that
 * would mean rung 1 never fires there and the pane silently runs whatever
 * `bash` PATH happens to hold instead of the user's login shell, sourcing
 * none of their config. The passwd entry IS the login shell (that is its
 * definition), so it answers honestly where the variable is missing.
 *
 * Live-only, on purpose: the env is the primary source, so an explicit
 * `SHELL` (and every test that injects one) still wins, and a caller that
 * injects `env` sees exactly the world it described, not this host's passwd.
 */
export async function detectBinary(name: string, envName: string, knownPaths: string[]): Promise<DetectionResult> {
  return detectBinaryWithOptions(name, envName, knownPaths, {
    env: withShellBackfill(process.env, accountLoginShell()),
  });
}

/**
 * The OS login shell for the current user, or `undefined` when the passwd
 * entry cannot be read or names none. The ONLY source that survives a
 * service-managed boot, where `SHELL` is absent from the process env.
 */
export function accountLoginShell(): string | undefined {
  try {
    return userInfo().shell || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `env` with `SHELL` backfilled from `accountShell` when the env does not
 * already carry one.
 *
 * Pure (the passwd read is the caller's), so the three answers are pinable
 * without a live getpwuid: an explicit `SHELL` WINS (identity returned, not a
 * copy — it is already the answer), a missing one takes the account shell,
 * and a machine that can name neither gets the env untouched so the ladder
 * falls to the PATH rung. Spreading, not mutating: the caller's object is
 * `process.env` and must not gain a key.
 */
export function withShellBackfill(env: NodeJS.ProcessEnv, accountShell: string | undefined): NodeJS.ProcessEnv {
  if (env.SHELL) return env;
  return accountShell ? { ...env, SHELL: accountShell } : env;
}

/** Path-only view of {@link detectBinary}, for callers that cannot act on a reason. */
export async function findBinary(name: string, envName: string, knownPaths: string[]): Promise<string | null> {
  return (await detectBinary(name, envName, knownPaths)).path;
}

/** Path-only view of {@link detectBinaryWithOptions}. */
export async function findBinaryWithOptions(
  name: string,
  envName: string,
  knownPaths: string[],
  options: BinaryLookupOptions,
): Promise<string | null> {
  return (await detectBinaryWithOptions(name, envName, knownPaths, options)).path;
}

async function isExecutable(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const stat = await Bun.file(path).stat();
  return stat.isFile() && (stat.mode & 0o111) !== 0;
}

/**
 * Expands a leading `~` or `~/` against `home`, the one form of override a
 * systemd `Environment=` line or a hand-written unit reliably carries UNexpanded.
 * A `~user/...` is left verbatim (resolving another account's home is out of
 * scope); a relative or bare value is returned untouched so rung 1 can sort
 * pointer-from-no-pointer. `null`/`undefined` pass through.
 */
function expandHome(value: string | undefined, home: string): string | undefined {
  if (!value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}
