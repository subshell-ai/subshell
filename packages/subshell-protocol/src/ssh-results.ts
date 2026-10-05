import type { SshConnectionSnapshotWire } from "./ssh-config.js";
import type { SshErrorCode } from "./ssh-errors.js";
import type { SshControlMode, SshRunFactsWire } from "./ssh-run-facts.js";

/**
 * The SSH result ENVELOPE types - what each `ssh_*` command's `result{data}`
 * carries (the Gate A split from `ssh-frames.ts`; exported NAMES unchanged).
 * The `parse*` validators for these live in `node-results.ts` beside every
 * other result validator (the four-site rule in the integration maps); the
 * run-facts grammar they delegate to is {@link SshRunFactsWire}'s reader.
 *
 * Imports no `node:` builtin; lives in the Metro-safe barrel.
 */

/**
 * `ssh_discover_aliases` answer: NAMES of usable aliases, never config file
 * contents (SSH-SUPPORT.md §2). Wildcard-only entries are already excluded
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
       * - the §3 UI sentence "review resolved destination AND connecting OS
       * account" needs a name the snapshot itself never carries. Optional by
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
 * `ssh_test_connection` answer. The probe is FIXED and benign - the node runs
 * its own connect-and-exit check against the snapshot; there is no
 * caller-supplied probe text anywhere in this contract, and the boolean plus
 * a named code is the whole answer.
 */
export type NodeSshTestOutcomeWire = { passed: true } | { passed: false; code: SshErrorCode };

/**
 * `ssh_run_read` answer: the bounded incremental window plus a full copy of
 * the run facts - a read must always be able to answer "and is it done?"
 * without a second round trip, which is also what keeps a plane-driven
 * poll loop honest about a run that completed between windows.
 */
export interface NodeSshRunReadResult extends SshRunFactsWire {
  /** Base64 stdout bytes starting at the request's `stdoutFromByte`. */
  stdoutB64: string;
  /** Base64 stderr bytes starting at the request's `stderrFromByte`. */
  stderrB64: string;
  /** Offset to pass next for stdout (request offset + bytes returned). */
  stdoutNext: number;
  /** Offset to pass next for stderr. */
  stderrNext: number;
  /** Total bytes RETAINED for stdout (past `SSH_RUN_OUTPUT_RETENTION_BYTES` the node drained excess). */
  stdoutTotal: number;
  /** Total bytes RETAINED for stderr. */
  stderrTotal: number;
  /** Drain dropped bytes beyond the per-run retention; the window is not the whole transcript. */
  truncated: boolean;
}

/**
 * `ssh_input_control` answer: the node's CURRENT control state after the
 * transition (echoing what took effect, which is what lets the plane detect a
 * lost race against a takeover happening at the machine).
 */
export interface NodeSshControlResult {
  /** The managed pane (echo). */
  subshellId: string;
  /** Whose input the node now accepts. */
  mode: SshControlMode;
  /** The node's current input generation after this transition; later writes must carry at least this. */
  generation: number;
}
