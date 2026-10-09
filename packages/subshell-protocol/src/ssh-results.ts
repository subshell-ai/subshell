import type { SshConnectionSnapshotWire } from "./ssh-config.js";
import type { SshErrorCode } from "./ssh-errors.js";

/**
 * The SSH result ENVELOPE types - what the `ssh_*` commands' `result{data}`
 * carries (the Gate A split from `ssh-frames.ts`; exported NAMES unchanged).
 * The test/run/control envelopes retired with the destination product (design
 * 2026-10-05 §7); M2 added the identity report and the §5.4 roster. Their
 * `parse*` validators (`parseNodeSshAliasList`, `parseNodeSshResolveOutcome`,
 * `parseNodeSshIdentity`, `parseNodeSshAgentIdentities`) live in
 * `node-results.ts` beside every other result validator.
 *
 * Imports no `node:` builtin; lives in the Metro-safe barrel.
 */

/**
 * `ssh_discover_aliases` answer: NAMES of usable aliases, never config file
 * contents (docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md). Wildcard-only entries are already excluded
 * and include cycles detected (the cycle is a FACT the human reviewing the
 * list needs, never a silent stop).
 */
export interface NodeSshAliasListResult {
  /** Alias names, sorted, deduplicated, at most {@link SSH_MAX_DISCOVERED_ALIASES}. */
  aliases: string[];
  /** An include cycle was detected during the bounded parse; the list is what parsed before it. */
  includeCycle: boolean;
  /** The alias cap was hit; more exist. */
  truncated: boolean;
}

/**
 * `ssh_resolve_config` answer. The refusal is IN THE DATA, not an `ok:false`
 * result: "this config needs a ProxyCommand" is a SUCCESSFUL resolution
 * outcome the human must read (which setting blocked), not a transport error.
 * `settings` names the blocked settings by the config keyword (a `ProxyCommand`
 * row, a `LocalForward` row, …) so the human can edit the config and re-resolve.
 */
export type NodeSshResolveOutcomeWire =
  | {
      /** The alias normalized cleanly into an approved snapshot. */
      accepted: true;
      /** The snapshot the human reviews, then saves. */
      snapshot: SshConnectionSnapshotWire;
      /**
       * The connecting account's OS user name, when the node could report it
       * - the wizard's review of the resolved destination needs the connecting
       * OS account named, which the snapshot itself never carries. Optional by
       * design: an agent that cannot resolve `os.userInfo` answers without
       * it and the review proceeds (the destination facts are the load-
       * bearing half; this is display).
       */
      connectingAccount?: string;
    }
  | {
      /** Resolution refused: the config needs more than the approved normalization can run, or the destination is unusable. */
      accepted: false;
      /** The named limitation ({@link SshErrorCode} subset: unsupported_setting, config_missing, config_ambiguous, proxy_chain_too_long, …). */
      code: SshErrorCode;
      /** Config keywords that blocked acceptance; empty when the code names the whole cause. */
      settings: string[];
    };

/**
 * `ssh_register_identity` answer (spec 2026-10-08 §4.3): the machine's OWN
 * ES256 signing public key, for a node that enrolled before the key existed.
 * The grammar here only proves the field is a non-empty string carrying
 * well-formed JSON; the ES256/P-256 importability check (and the refusal of
 * any JWK holding a private component) is the SERVER's gate, beside the one
 * the enroll path runs.
 */
export interface NodeSshIdentityResult {
  /** JSON-serialized public JWK (P-256 / ES256) - never the private half. */
  signingPublicKey: string;
}

/**
 * One entry of the `ssh_agent_identities` answer (spec 2026-10-08 §5.4,
 * Task 11): the public identity A's agent carries, spelled so the operator's
 * selection can round trip into a grant unchanged.
 */
export interface NodeSshAgentIdentity {
  /** The OpenSSH display fingerprint: `SHA256:` + base64url over the agent WIRE encoding of the public blob (the grant grammar's shape, {@link isSshGrantFingerprint}). */
  fingerprint: string;
  /** OpenSSH's label for the key, passed through as text; the empty comment is legal. */
  comment: string;
}

/**
 * `ssh_agent_identities` answer (spec 2026-10-08 §5.4): A's agent's WHOLE
 * public roster as fingerprints plus comments, with the key BLOBS withheld.
 * The shape has no slot for key material by construction: the validator
 * rebuilds each entry from its two checked fields, so a `blob` member a buggy
 * or hostile node tried to ship is dropped at the grammar, and an empty
 * roster from a live agent is a legal answer (distinct from the named error
 * an offline or unparseable roster produces, which never reaches this shape).
 */
export interface NodeSshAgentIdentitiesResult {
  /** Every public identity A's live agent carries; the approval screen's choice list. */
  identities: NodeSshAgentIdentity[];
}

/**
 * `ssh_host_key` answer (spec 2026-10-08 §9, Task 12): the entries A's
 * connecting account has recorded for ONE resolved destination, each in
 * OpenSSH's own `known_hosts` line spelling (pattern, key type, base64 key
 * material, optional comment), verbatim. An EMPTY list is the honest fact "A
 * has recorded nothing for this destination" - a distinct answer from the
 * named error an unreadable file or a missing tool produces, and the capture
 * service fails the grant creation closed on exactly this empty answer
 * (a relay grant must carry a pin). The key material here is PUBLIC by
 * nature (a known_hosts entry is what a client uses to CHECK a server), and
 * it is what becomes the pin; the audit rows name only the destination and
 * the entry's `SHA256:` fingerprint, never these bytes.
 */
export interface NodeSshHostKeyResult {
  /** Every `known_hosts` line matching the destination's lookup; verbatim, at most SSH_MAX_HOST_KEY_LINES. */
  lines: string[];
}

/**
 * The ack of a kicked `ssh_exec` (spec 2026-10-08 §7, Task 14): the run was
 * accepted and started off the command chain (an installer takes minutes; a
 * chain-occupying executor would stall the machine the act is meant to leave
 * untouched). The outcome arrives through {@link NodeSshExecStatusResult}.
 */
export interface NodeSshExecKickResult {
  /** True is the ONLY legal value: a kick that did not start answers `ok:false`, not this shape. */
  started: true;
  /** The act id echoed back, so a reply is matched to its kick by equality. */
  execId: string;
}

/**
 * The pollable state of one `ssh_exec` (Task 14). `running` says the child is
 * alive and nothing is kept of it yet; `done` carries the terminal facts: the
 * exit code (null when a signal or a failed spawn left none), whether the
 * deadline ended it, and the installer's captured output AFTER the node's
 * own `nsk_` redaction and tail truncation. The plane redacts again; what
 * reaches the pane, the log, or the trail is never a machine's raw word.
 */
export type NodeSshExecStatusResult =
  | { state: "running" }
  | {
      state: "done";
      /** The child's exit code; null on signal death or a spawn that never ran. */
      code: number | null;
      /** True when the node-side deadline ended the run (the child is gone). */
      timedOut: boolean;
      /** Captured stdout, redacted and tail-truncated ({@link SSH_EXEC_RETAIN_BYTES}). */
      stdout: string;
      /** Captured stderr, redacted and tail-truncated ({@link SSH_EXEC_RETAIN_BYTES}). */
      stderr: string;
    };
