import { homedir } from "node:os";
import { log } from "./log.js";

/**
 * The environment side of the `detect` round trip (spec 2026-09-10 §5, as
 * amended by the final review).
 *
 * The rule: the PLANE names the variables (the union of `subshell.hostEnv`
 * across its enabled harness manifests, on every `detect` command), and this
 * machine answers the VALUES it has for exactly those names, and nothing else
 * — the reported set grows by declaration on the control plane, never by a
 * node shipping its whole environment. An earlier design had the node read
 * the declarations itself at `ready`, from manifests under its own data dir;
 * since the inversion (§6) a node holds no plugins at all, so it can no
 * longer even know the NAMES. The plane holds them.
 *
 * This module answers questions. It never scans: a name no one asked about
 * is never looked at, and there is no directory of manifests left to read.
 */

/**
 * Values for the named environment variables that are SET here.
 * Total: an unreadable name is not a concept here (a plain key lookup cannot
 * fail), and an empty `names` array answers `{}`.
 * @param names - the variable names the plane asked about (its `detect` frame's `envNames`)
 * @returns values for every named variable that is set; unset ones stay ABSENT,
 *          which is what tells the plugin its override is unset and its own
 *          fallback applies — a fabricated value would silently change a path
 */
export function hostEnvAnswers(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    // Present ones only: an absent key is the documented fallback trigger.
    // Present-but-EMPTY is reported as empty — whether "" counts as "set" is
    // the plugin's decision (claude trims it into its fallback), not this one.
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * This user's home directory, for the `ready` frame (resume-path defaults
 * hang off it; spec §5). Total: a home the OS cannot name answers the empty
 * string, which the control plane treats exactly like an unreported one —
 * the computed path degrades to a relative default that simply stats absent.
 * `ready` rides every connect, so this must never throw.
 */
export function reportHomeDir(): string {
  try {
    return homedir();
  } catch (err) {
    log(`could not read this user's home directory: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}
