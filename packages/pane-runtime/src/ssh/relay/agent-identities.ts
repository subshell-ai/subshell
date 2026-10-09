import { type JsonValue, parseNodeSshAgentIdentities, SSH_ROSTER_MAX_IDENTITIES } from "@internal/subshell-protocol";
import type { AgentIdentity, AgentRequestFn } from "./relay-agent-scheme.js";
import { fingerprintAgentBlob, parseIdentitiesAnswer, probeAgentScheme } from "./relay-agent-scheme.js";
import { liveAgentSocketPath, requestLiveAgent } from "./relay-agent-socket.js";

import type { MachineSshResult } from "./result.js";
/** Test seams for {@link readMachineAgentIdentities} (production omits both). */
export interface AgentIdentitiesSeams {
  /** Where A's live agent socket is; defaults to the real `SSH_AUTH_SOCK` lookup. */
  resolveAgentSocket?: () => string | null;
  /** One framed agent round trip; defaults to the real socket client. */
  requestAgent?: AgentRequestFn;
}

/**
 * `ssh_agent_identities` (spec 2026-10-08 §5.4, Task 11): enumerate this
 * machine's LIVE agent public identities for the key-selection screen,
 * as `{ identities: [{ fingerprint, comment }] }` with the key BLOBS
 * withheld - the fingerprints are the selection grammar's own `SHA256:` spelling
 * (over the agent WIRE encoding, {@link fingerprintAgentBlob}), so whatever
 * the operator selects round trips into the relay command verbatim.
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
 *   refused or unparsable roster, or a roster past
 *   {@link SSH_ROSTER_MAX_IDENTITIES} each answer `ok:false` with a named
 *   error; an oversized roster is refused, never truncated down to the bound.
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
export async function readMachineAgentIdentities(seams?: AgentIdentitiesSeams): Promise<MachineSshResult> {
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
  if (entries.length > SSH_ROSTER_MAX_IDENTITIES) {
    // The count bound (PR #338 review round 2): the parse takes whatever
    // count the agent declares, so the refusal is here. Never a silent
    // truncation - a roster cut to fit would read to the operator as the
    // agent's whole truth. The error names the cause and the counts only:
    // no fingerprint, comment, or blob byte.
    return {
      ok: false,
      error: `the agent reported ${entries.length} identities, past the ${SSH_ROSTER_MAX_IDENTITIES}-identity roster bound; refusing to answer an oversized roster`,
    };
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
