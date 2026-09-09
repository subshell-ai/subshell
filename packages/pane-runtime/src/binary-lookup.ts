import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 *   1. `env[ENV_NAME]` (explicit override, e.g. CLAUDE_PATH)
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
  const explicit = env[envName];
  if (explicit) {
    // An override that does not resolve is an answer, not a hint: the operator
    // said where it is, and searching past them would hide their mistake.
    if (await isExecutable(explicit)) return { path: explicit };
    return { path: null, reason: "override-invalid" };
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
 */
export async function detectBinary(name: string, envName: string, knownPaths: string[]): Promise<DetectionResult> {
  return detectBinaryWithOptions(name, envName, knownPaths, { env: process.env });
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
