import { type AgentIdentitiesSeams, readMachineAgentIdentities } from "@internal/pane-runtime";
import { type JsonValue, parseNodeSshIdentity } from "@internal/subshell-protocol";
import { loadOrCreateIdentity } from "../identity.js";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { CommandContext, CommandResult } from "./context.js";
import { SSH_GATE_REFUSAL } from "./ssh-shared.js";

/**
 * `ssh_register_identity` (spec 2026-10-08 §4.3): the machine reports its
 * ES256 relay SIGNING public key so a node that enrolled before M2 fills the
 * plane's `signingPublicKey` slot over the already-authenticated, app-layer-
 * encrypted node link.
 *
 * The answer is run through the frozen wire validator on the way out (the
 * `ssh-aliases.ts` posture), and only `signingPublicJwk` is read: the private
 * half never enters a result frame. The bytes are STABLE by construction -
 * `loadOrCreateIdentity` never rotates a present file, and a corrupt one
 * quarantines and throws (dispatch answers `ok:false`, the plane stores
 * nothing) rather than letting a silent rotation ride out as a "re-report"
 * the plane's §4.3 own-registration guard would refuse.
 *
 * NO ssh-enabled gate check, unlike the two config arms: this is the
 * machine's own registration, not an SSH act. `set_ssh_enabled` is the
 * precedent for a command the gate cannot govern, and a pre-M2 node reaches
 * this BEFORE anyone has ever enabled SSH on it.
 *
 * @param ctx - the per-daemon execution context (data dir)
 * @returns `{ ok: true, data: { signingPublicKey } }` with the PUBLIC JWK only
 */
export async function execSshRegisterIdentity(ctx: CommandContext): Promise<CommandResult> {
  const identity = await loadOrCreateIdentity(ctx.config.dataDir);
  const validated = parseNodeSshIdentity({ signingPublicKey: identity.signingPublicJwk });
  if (validated === null) return { ok: false, error: "malformed signing identity" };
  // The seam cast: JSON-safe by construction, contract owned by `node-results.ts`.
  return { ok: true, data: validated as unknown as JsonValue };
}

export type { AgentIdentitiesSeams } from "@internal/pane-runtime";
/** Gate agent enumeration before any socket lookup. */
export async function execSshAgentIdentities(
  ctx: CommandContext,
  seams?: AgentIdentitiesSeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  return readMachineAgentIdentities(seams);
}
