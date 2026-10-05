import { defaultSshConfigPath, discoverSshAliases, resolveSshAliasConfig } from "@internal/pane-runtime";
import { type JsonValue, parseNodeSshAliasList, parseNodeSshResolveOutcome } from "@internal/subshell-protocol";
import type { Cmd, CommandResult } from "./context.js";
import { connectingHomeDir, resolveSshBin } from "./ssh-shared.js";

/**
 * The two human-config SSH executors that touch no connection state:
 *
 * - `ssh_discover_aliases` — bounded config parse answering NAMES only
 *   (§2: "Discovery returns names, not config file contents"). The answer is
 *   run through the frozen wire validator on the way out.
 * - `ssh_resolve_config` — `ssh -G` evaluation of one alias through
 *   pane-runtime's `resolveSshAliasConfig`, plus this machine's connecting
 *   account name for the §3 review card ("review resolved destination AND
 *   connecting OS account"). A refusal is a SUCCESSFUL answer (the outcome
 *   rides `accepted:false` in the data) so the human reads WHICH setting
 *   blocked; only a missing ssh binary is a command failure.
 *
 * The disclosure §2 demands before this runs — that a trusted `Match exec`
 * can execute locally during resolution — belongs to the human-facing surface
 * that dispatches it (the SPA settings flow), not to the node.
 */

/** Execute `ssh_discover_aliases`. */
export async function execSshDiscoverAliases(): Promise<CommandResult> {
  const home = connectingHomeDir();
  const found = discoverSshAliases({ homeDir: home, configPath: defaultSshConfigPath(home) });
  const validated = parseNodeSshAliasList({
    aliases: found.aliases,
    includeCycle: found.includeCycle,
    truncated: found.truncated,
  });
  if (validated === null) return { ok: false, error: "malformed alias discovery" };
  // The seam cast: JSON-safe by construction, contract owned by `node-results.ts`.
  return { ok: true, data: validated as unknown as JsonValue };
}

/** Execute `ssh_resolve_config` for one alias. */
export async function execSshResolveConfig(cmd: Cmd<"ssh_resolve_config">): Promise<CommandResult> {
  const sshBin = await resolveSshBin();
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
  const home = connectingHomeDir();
  const outcome = await resolveSshAliasConfig(cmd.alias, {
    sshBin,
    homeDir: home,
    configPath: defaultSshConfigPath(home),
  });
  const validated = parseNodeSshResolveOutcome(outcome);
  if (validated === null) return { ok: false, error: "malformed resolve outcome" };
  return { ok: true, data: validated as unknown as JsonValue };
}
