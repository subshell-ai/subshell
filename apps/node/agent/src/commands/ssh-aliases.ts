import { defaultSshConfigPath, discoverSshAliases, resolveSshAliasConfig } from "@internal/pane-runtime";
import { type JsonValue, parseNodeSshAliasList, parseNodeSshResolveOutcome } from "@internal/subshell-protocol";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { connectingHomeDir, resolveSshBin, SSH_GATE_REFUSAL } from "./ssh-shared.js";

/**
 * The two human-config SSH executors that touch no connection state (spec
 * 2026-10-07 §5/§7):
 *
 * - `ssh_discover_aliases` — bounded config parse answering NAMES only
 *   (discovery answers names, never config file contents). The answer is
 *   run through the frozen wire validator on the way out.
 * - `ssh_resolve_config` — `ssh -G` evaluation of one alias through
 *   pane-runtime's `resolveSshAliasConfig`, plus this machine's connecting
 *   account name on the outcome's `connectingAccount`: the review step
 *   needs the connecting OS account named alongside the resolved
 *   destination. A refusal is a SUCCESSFUL answer (the outcome
 *   rides `accepted:false` in the data) so the human reads WHICH setting
 *   blocked; only a missing ssh binary is a command failure.
 *
 * EVERY arm consults this machine's ssh-enabled mirror FIRST (§4.3's gate
 * doctrine): a machine whose local copy is not ON answers
 * {@link SSH_GATE_REFUSAL} before any binary lookup, any config read, or any
 * spawn — regardless of what the plane believes about it. The mirror is
 * fail-closed, so absent and unreadable refuse exactly like off.
 *
 * The disclosure the resolve step owes the human (the engine's note in
 * pane-runtime `ssh-resolve.ts`: a `Match exec` the bounded config walk
 * cannot see still executes locally under `ssh -G`) belongs to the
 * human-facing surface, never the node: in this tier it rides the plane's
 * resolve and launch route descriptions (`/api/ssh/resolve`,
 * `/api/ssh/launch`), and the launcher UI copy ships with Plan 3.
 */

/** Does this machine permit SSH right now? (the one question every arm asks first) */
function gateOpen(ctx: CommandContext): boolean {
  return sshAllowed(readSshEnabled(ctx.config.dataDir));
}

/** Execute `ssh_discover_aliases`. */
export async function execSshDiscoverAliases(ctx: CommandContext): Promise<CommandResult> {
  if (!gateOpen(ctx)) return { ok: false, error: SSH_GATE_REFUSAL };
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
export async function execSshResolveConfig(
  ctx: CommandContext,
  cmd: Cmd<"ssh_resolve_config">,
): Promise<CommandResult> {
  if (!gateOpen(ctx)) return { ok: false, error: SSH_GATE_REFUSAL };
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
