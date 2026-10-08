/**
 * The SSH node commands: the bounded config DISCOVERY and the single-alias
 * RESOLUTION that feed the wizard's review step (design 2026-10-05 §7), and
 * the M2 §4.3 IDENTITY bootstrap a pre-M2 node answers once. They ride the
 * existing signed/encrypted command transport unchanged - signing proves WHO
 * ordered it, this file freezes WHAT was ordered.
 *
 * The rest of the family the earlier command table named (`ssh_test_
 * connection`, the run start/status/read/cancel quartet, `ssh_terminal_
 * launch`, `ssh_input_control`) retired with that destination-execution
 * product, which never shipped; their `type` arms are therefore deleted, not
 * refused. The sealed agent-relay milestone (M2) adds ONE command here,
 * `ssh_register_identity` (§4.3 bootstrap: a pre-M2 node's signing key reaches
 * the plane inside a signed command on the existing node link). The
 * brokered-session commands are NOT defined yet - they land with the relay
 * frames themselves (`ssh-limits.ts` carries their limits ahead of the frames,
 * as it declares).
 *
 * The commands are TRANSPORT-AGNOSTIC plain objects: the server-hosted
 * `local` node executes the same runtime in-process against these exact
 * bodies, so nothing may assume a socket, a jti, or a signature - those are
 * the transport's, and they live outside the body.
 *
 * Hand-rolled in the `node-frames.ts` style; imports no `node:` builtin, so
 * it rides the Metro-safe barrel with the rest of the grammar. The wiring
 * landed with the launcher tier: `parseNodeCommandBody` dispatches these two
 * arms here, and `node-results.ts` validates their answers.
 */

import { isRecord, isStr } from "./guards.js";
import { SSH_NAME_MAX_CHARS } from "./ssh-limits.js";

/* ------------------------------------------------------------------ */
/* command bodies                                                      */
/* ------------------------------------------------------------------ */

/**
 * Bounded parse of the connecting account's SSH config for alias NAMES. Takes
 * no input beyond the command itself (which node answers it is the
 * transport's, not the body's). Human-only at the API level; the node holds
 * no concept of who asked - the signature already did that part.
 */
export interface SshDiscoverAliasesCommand {
  type: "ssh_discover_aliases";
}

/** Resolve one alias into the approved normalized snapshot (or a named refusal). Human config step. */
export interface SshResolveConfigCommand {
  type: "ssh_resolve_config";
  /** The config token to resolve. Shape-checked here; whether it EXISTS in the account's config is what the command is for. */
  alias: string;
}

/**
 * The machine reports its OWN ES256 relay signing public key (spec
 * 2026-10-08 §4.3): the once-over-the-link bootstrap for a node that enrolled
 * before the key existed. No input beyond the type - the answer is the
 * machine's own identity, there is nothing for the plane to ask about.
 */
export interface SshRegisterIdentityCommand {
  type: "ssh_register_identity";
}

/** Every SSH-family command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshNodeCommandBody = SshDiscoverAliasesCommand | SshResolveConfigCommand | SshRegisterIdentityCommand;

/** Every SSH command `type`, for census tests and dispatch tables. */
export const SSH_COMMAND_TYPES = ["ssh_discover_aliases", "ssh_resolve_config", "ssh_register_identity"] as const;

/* ------------------------------------------------------------------ */
/* arm validators (delegated from parseNodeCommandBody)                */
/* ------------------------------------------------------------------ */

/** Same hygiene the snapshot applies to names; a config alias is the same kind of string. */
function isAliasName(value: unknown): value is string {
  return (
    isStr(value) &&
    value.length > 0 &&
    value.length <= SSH_NAME_MAX_CHARS &&
    !value.startsWith("-") &&
    !/\s|\p{Cc}/u.test(value)
  );
}

/**
 * Validates and narrows any `ssh_*` command body. `parseNodeCommandBody`
 * routes its two `type` arms here, so the SSH grammar lives in ONE file
 * beside the commands it narrows. The contract this upholds is
 * the same as the node commands' today: a NON-null return is safe to switch
 * on by `type`.
 *
 * @param value - candidate payload whose `type` starts with `ssh_`
 * @returns the narrowed command, or null when malformed
 */
export function parseSshNodeCommandBody(value: unknown): SshNodeCommandBody | null {
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "ssh_discover_aliases":
      return { type: "ssh_discover_aliases" };
    case "ssh_resolve_config":
      return isAliasName(value.alias) ? { type: "ssh_resolve_config", alias: value.alias } : null;
    case "ssh_register_identity":
      // The whole command is its type: the machine answers about ITSELF, and
      // the answer's shape is `node-results.ts`'s business, not this grammar's.
      return { type: "ssh_register_identity" };
    default:
      return null;
  }
}
