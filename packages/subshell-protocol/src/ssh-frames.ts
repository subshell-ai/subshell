/**
 * The two surviving SSH node commands (design 2026-10-05 §7): the bounded
 * config DISCOVERY and the single-alias RESOLUTION that feed the wizard's
 * review step. They ride the existing signed/encrypted command transport
 * unchanged - signing proves WHO ordered it, this file freezes WHAT was
 * ordered.
 *
 * The rest of the family the earlier command table named (`ssh_test_
 * connection`, the run start/status/read/cancel quartet, `ssh_terminal_
 * launch`, `ssh_input_control`) retired with the destination execution
 * product; protocol 17 never shipped, so their `type` arms are deleted, not
 * refused. The brokered-session commands live in `ssh-session-frames.ts`.
 *
 * The commands are TRANSPORT-AGNOSTIC plain objects: the server-hosted
 * `local` node executes the same runtime in-process against these exact
 * bodies, so nothing may assume a socket, a jti, or a signature - those are
 * the transport's, and they live outside the body.
 *
 * Hand-rolled in the `node-frames.ts` style; imports no `node:` builtin, so
 * it COULD join the Metro-safe barrel, but does not yet: on this tier the
 * grammar fixtures' type imports are its only consumer, and Plan 2 exports
 * and dispatches it with the ssh RPC verbs.
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

/** Every SSH-family command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshNodeCommandBody = SshDiscoverAliasesCommand | SshResolveConfigCommand;

/** Every SSH command `type`, for census tests and dispatch tables. */
export const SSH_COMMAND_TYPES = ["ssh_discover_aliases", "ssh_resolve_config"] as const;

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
 * Validates and narrows any `ssh_*` command body. Plan 2 routes
 * `parseNodeCommandBody`'s two `type` arms here, so the SSH grammar lives in
 * ONE file beside the commands it narrows; until that wiring lands no
 * `ssh_*` frame is dispatched on this branch. The contract this upholds is
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
    default:
      return null;
  }
}
