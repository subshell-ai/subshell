import type { SshConnectionSnapshotWire } from "./ssh-config.js";
import type { SshErrorCode } from "./ssh-errors.js";

/**
 * The SSH result ENVELOPE types - what the two surviving `ssh_*` discovery
 * commands' `result{data}` carries (the Gate A split from `ssh-frames.ts`;
 * exported NAMES unchanged). The test/run/control envelopes retired with the
 * destination product (design 2026-10-05 §7). The `parse*` validators for
 * these live in `node-results.ts` beside every other result validator (the
 * four-site rule in the integration maps).
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
