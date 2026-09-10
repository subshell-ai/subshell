import { homedir } from "node:os";
import { listInstalled } from "@internal/pane-runtime";
import { log } from "./log.js";

/**
 * The environment a `ready` frame reports (spec 2026-09-10 §5).
 *
 * The rule: this machine's `homeDir` plus the VALUES of the variables the
 * installed plugins' manifests declared (`subshell.hostEnv`), and nothing
 * else — the reported set grows by declaration, never by a node shipping its
 * whole environment to the control plane.
 *
 * Reads manifest DATA only, via the same `listInstalled` the inventory scan
 * uses: identity and detection already live in package.json precisely so a
 * scan loads no plugin code, and the ready frame — sent on every connect,
 * including before any plugin is ever used — is not where that principle
 * gets its exception. A plugin that cannot load (broken) declares nothing
 * worth reporting; its code cannot run, so its variables are nobody's
 * question.
 */
export interface HostEnvReport {
  /** The agent user's home directory (resume-path defaults hang off it) */
  homeDir: string;
  /** Values for every declared variable that is SET here; unset ones stay absent */
  env: Record<string, string>;
}

/**
 * Build the report. Total: a missing or unreadable plugins directory simply
 * declares nothing, and a failure to even look is logged, never thrown —
 * there is always a `ready` to send, with a home and an empty env at worst.
 */
export async function hostEnvReport(dataDir: string): Promise<HostEnvReport> {
  const names = new Set<string>();
  try {
    for (const installed of await listInstalled(dataDir)) {
      if (installed.broken) continue;
      for (const name of installed.manifest.hostEnv ?? []) names.add(name);
    }
  } catch (err) {
    log(`could not read plugin manifests for the env report: ${err instanceof Error ? err.message : String(err)}`);
  }
  const env: Record<string, string> = {};
  for (const name of names) {
    // Present ones only: an absent key is what tells the plugin its override
    // is unset, so reporting a fabricated value would silently change a path.
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  let homeDir: string;
  try {
    homeDir = homedir();
  } catch (err) {
    // TOTAL is the contract: `ready` rides every connect, and a home the OS
    // cannot name must degrade to the same "no homeDir reported" state an
    // older node has, which the control plane already computes a default
    // path from. The ready frame is worth more than the home.
    log(`could not read this user's home directory: ${err instanceof Error ? err.message : String(err)}`);
    return { homeDir: "", env };
  }
  return { homeDir, env };
}
