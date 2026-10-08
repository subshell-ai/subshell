import { type JsonValue, parseNodeSshAgentIdentities, parseNodeSshIdentity } from "@internal/subshell-protocol";
import { loadOrCreateIdentity } from "../identity.js";
import type { AgentIdentity, AgentRequestFn } from "../relay-agent-scheme.js";
import { fingerprintAgentBlob, parseIdentitiesAnswer, probeAgentScheme } from "../relay-agent-scheme.js";
import { liveAgentSocketPath, requestLiveAgent } from "../relay-agent-socket.js";
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

/** Test seams for {@link execSshAgentIdentities} (production omits both). */
export interface AgentIdentitiesSeams {
  /** Where A's live agent socket is; defaults to the real `SSH_AUTH_SOCK` lookup. */
  resolveAgentSocket?: () => string | null;
  /** One framed agent round trip; defaults to the real socket client. */
  requestAgent?: AgentRequestFn;
}

/**
 * `ssh_agent_identities` (spec 2026-10-08 §5.4, Task 11): enumerate this
 * machine's LIVE agent public identities for the first-use approval screen,
 * as `{ identities: [{ fingerprint, comment }] }` with the key BLOBS
 * withheld - the fingerprints are the grant grammar's own `SHA256:` spelling
 * (over the agent WIRE encoding, {@link fingerprintAgentBlob}), so whatever
 * the operator selects round trips into a grant verbatim.
 *
 * The three rules this arm keeps:
 * - **The gate speaks first** (the config arms' doctrine): this reads the
 *   connecting account's SSH agent, so it is an SSH act, and a machine whose
 *   mirror is not ON refuses {@link SSH_GATE_REFUSAL} before any socket is
 *   consulted. Unlike {@link execSshRegisterIdentity} - the machine's own
 *   registration - there is no pre-SSH reason to ask a roster.
 * - **The scheme is probed, never assumed** (ruling 2026-10-08): the
 *   identities codepoint depends on which numbering the live agent speaks,
 *   so {@link probeAgentScheme} runs against the same socket with the same
 *   positive-confirmation rule as the relay responder, and an agent that
 *   resolves nothing is refused by name rather than asked under a guess.
 * - **Fail closed, never fabricate**: no socket, an unresolvable scheme, a
 *   refused or unparsable roster each answer `ok:false` with a named error.
 *   An EMPTY roster from a live agent is the honest answer (`{identities:[]}`)
 *   - it is A reporting zero keys, which is a fact; the plane's offline path
 *   keeps the grant request pending precisely so a fabrication cannot read as
 *   one. No audit row is written here, on either side, and no blob byte
 *   reaches the result frame, a log line, or the answer's JSON.
 *
 * @param ctx - the per-daemon execution context (data dir for the gate mirror)
 * @param seams - test-only socket/round-trip seams
 * @returns `{ ok: true, data: { identities } }`, or the named refusal
 */
export async function execSshAgentIdentities(
  ctx: CommandContext,
  seams?: AgentIdentitiesSeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  const socketPath = (seams?.resolveAgentSocket ?? liveAgentSocketPath)();
  if (socketPath === null) {
    return { ok: false, error: "no live agent socket (SSH_AUTH_SOCK unset): cannot read the roster" };
  }
  const requestAgent = seams?.requestAgent ?? requestLiveAgent;
  const scheme = await probeAgentScheme(socketPath, requestAgent);
  if (scheme === null) {
    return {
      ok: false,
      error: "cannot resolve the agent's identities numbering: the roster read refuses rather than guess",
    };
  }
  let answer: Buffer;
  try {
    answer = await requestAgent(socketPath, Buffer.from([scheme.identities]));
  } catch (err) {
    return { ok: false, error: `the agent roster request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let entries: AgentIdentity[];
  try {
    entries = parseIdentitiesAnswer(answer, scheme);
  } catch {
    // A FAILURE answer, a foreign scheme's byte, or a truncated roster: the
    // partial-parse risk §5.4 refuses. The plane's caller keeps the approval
    // question pending on this error, which is the fail-closed half.
    return { ok: false, error: "the agent's IDENTITIES_ANSWER did not parse; refusing to answer a partial roster" };
  }
  // The blobs are discarded HERE, before any validator sees the answer: the
  // result frame structurally cannot carry one.
  const validated = parseNodeSshAgentIdentities({
    identities: entries.map((entry) => ({
      fingerprint: fingerprintAgentBlob(entry.blob),
      comment: entry.comment.toString("utf8"),
    })),
  });
  if (validated === null) return { ok: false, error: "malformed agent roster" };
  // The seam cast: JSON-safe by construction, contract owned by `node-results.ts`.
  return { ok: true, data: validated as unknown as JsonValue };
}
