/**
 * The client shapes of the `/api/ssh` surface (specs 2026-10-07 and
 * 2026-10-08), the same mirror `lib/prompts.ts` keeps for the prompt library:
 * local types that state the wire field for field, read through `apiFetch<T>`. The
 * definitions live beside the routes that answer them
 * (`apps/server/api/src/api/ssh/ssh-views.ts`); the copy here restates that
 * contract for the SPA, and the two are kept honest by review like every
 * other mirror type in this app.
 */

import { SSH_MAX_SELECTED_FINGERPRINTS } from "@internal/subshell-protocol";

/** One ProxyJump hop as the frozen snapshot spells it. */
export interface SshHop {
  /** Hop hostname (bracketed IPv6 literal kept as given) */
  host: string;
  /** Hop user; null means the connecting account's own default */
  user: string | null;
  /** Hop port, resolved */
  port: number;
}

/**
 * The approved connection snapshot, exactly as the resolve/422 outcome
 * serializes it. The always-null fields are load-bearing: a resolved value
 * that the approved normalization cannot run makes the destination REFUSABLE,
 * never renderable — so a field arriving non-null here is a server bug, and
 * the `null` type is the wire's way of saying the panel never has to render
 * one.
 */
export interface SshSnapshot {
  /** The config token the human chose (display and review context only) */
  alias: string;
  /** Resolved destination hostname */
  host: string;
  /** Destination user; null means the connecting account's own default */
  user: string | null;
  /** Destination port, resolved (1..65535) */
  port: number;
  /** Identity file references (absolute paths on the connecting machine, never key contents) */
  identityFiles: string[];
  /** Certificate file references (paths only) */
  certificateFiles: string[];
  /** The authentication-agent socket to use, or null (runs with no agent) */
  authAgentSocket: string | null;
  /** Known-hosts files to consult (paths only) */
  knownHostsFiles: string[];
  /** The name strict host checking looks up, or null */
  hostKeyAlias: string | null;
  /** Bounded ProxyJump chain, outermost first */
  proxyJumps: SshHop[];
  /** Always null: a resolved ProxyCommand refuses the snapshot, never renders it */
  proxyCommand: null;
  /** Always null: any resolved forwarding refuses the snapshot */
  forwards: null;
  /** Always null: any resolved tunnel refuses the snapshot */
  tunnels: null;
  /** Always null: any resolved local command refuses the snapshot */
  localCommands: null;
  /** Always null: a resolved RemoteCommand refuses the snapshot */
  remoteCommand: null;
  /** Always null: a resolved SendEnv refuses the snapshot */
  sendEnv: null;
  /** Always null: a resolved SetEnv refuses the snapshot */
  setEnv: null;
  /** Always null: live escape characters refuse the snapshot */
  escapes: null;
}

/**
 * `POST /api/ssh/resolve`'s answer, and the body of every 422 the launch and
 * save endpoints answer: the refusal is IN THE DATA, so the panel renders it
 * rather than catching it. `code` is an `SshErrorCode` name
 * (unsupported_setting, config_missing, config_ambiguous,
 * proxy_chain_too_long, host_key_unknown, …); `settings` names what blocked,
 * empty when the code names the whole cause.
 */
export type SshResolveOutcome =
  | {
      /** The destination normalized cleanly into an approved snapshot */
      accepted: true;
      snapshot: SshSnapshot;
      /** The connecting account's OS user name, when the machine could report it (display only) */
      connectingAccount?: string;
    }
  | {
      /** Resolution refused: the config needs more than the approved normalization can run */
      accepted: false;
      code: string;
      settings: string[];
    };

/** One saved/recency row as its owner sees it. */
export interface SshSavedHost {
  /** Row id (uuid) */
  id: string;
  /** Canonical host:port (or user@host:port), the resolved destination as key */
  destination: string;
  /** Display token (the alias typed or discovered); never a key */
  alias: string | null;
  /** The connecting machine of the most recent launch to this destination */
  nodeId: string;
  /** ISO 8601 the human saved it; null = recency-only row */
  savedAt: string | null;
  /** ISO 8601 of the most recent launch to this destination */
  lastConnectAt: string;
}

/** The `GET /api/ssh/saved-hosts` body: the destination field's feed and the machine preference. */
export interface SshSavedHostsView {
  /** Rows a human saved, newest save first (max 20) */
  saved: SshSavedHost[];
  /** Most-recently-connected destinations, saved or not, newest first (max 20) */
  recent: SshSavedHost[];
  /**
   * The caller's default connecting machine, or null. A node deleted since
   * reads back as the stored id; the client decides.
   */
  defaultNodeId: string | null;
}

/** The `GET /api/ssh/aliases?node=` body: names only, never config contents. */
export interface SshAliasesView {
  /** Usable alias NAMES (sorted, deduplicated, concrete names only), at most 500 */
  aliases: string[];
  /** An include cycle was detected; the list is what parsed before it */
  includeCycle: boolean;
  /** The alias cap was hit; more exist */
  truncated: boolean;
}

/** `PUT /api/ssh/saved-hosts` body: the machine gates the resolve, the alias is a display override. */
export interface SshSaveHostRequest {
  /** Machine to resolve the destination on (the gate owner) */
  node: string;
  /** Destination token (1..253): an alias from the machine's config or a concrete host */
  destination: string;
  /** Display label override; absent keeps the resolved snapshot's own alias */
  alias?: string;
}

/** `POST /api/ssh/launch` body: name is the pane's display name, optional. */
export interface SshLaunchRequest {
  /** Optional machine whose SSH agent supplies keys; absent uses the connecting machine. */
  keyHome?: string;
  fingerprints?: string[];
  /** Connecting machine ('local' = the control-plane host) */
  node: string;
  /** Destination token (1..253), resolved on the machine before anything launches */
  destination: string;
  /** Pane display name */
  name?: string;
}

/**
 * The `POST /api/ssh/launch` 201 body. The wire carries the full subshell
 * view; only the id is declared because only the id is consumed — success
 * navigates to `/subshells/$id`, exactly like the launch dialog's create.
 */
export interface SshLaunchResponse {
  subshell: { id: string };
}

/** One key home agent identity from the live agent roster (blobs are withheld by construction). */
export interface SshAgentIdentity {
  /** Public agent identity in the canonical SHA256: notation (sent verbatim when connecting) */
  fingerprint: string;
  /** OpenSSH's label for the key, as the agent reports it (display only) */
  comment: string;
}

/** One pinned destination host key (spec 2026-10-08 §9): destination + public fingerprint, never key bytes. */
export interface SshHostPin {
  /** Pin row id (uuid) */
  id: string;
  /** Canonical resolved destination `user@host:port` */
  destination: string;
  /** The pinned key's SHA256: display fingerprint (public identifier) */
  fingerprint: string;
  /** ISO 8601 first capture (the TOFU moment) */
  createdAt: string;
  /** ISO 8601 of the last accepted match */
  updatedAt: string;
}

/**
 * The client-side spelling of the server's hard selection cap (spec
 * 2026-10-08 §5.4): the same sentence the refusing service answers
 * (`ssh-relay-launch.service.ts`), so the red line on the card and a refused POST
 * read identically.
 */
export function sshSelectionError(fingerprints: readonly string[]): string | null {
  if (fingerprints.length <= SSH_MAX_SELECTED_FINGERPRINTS) return null;
  return `Select at most ${SSH_MAX_SELECTED_FINGERPRINTS} SSH keys before connecting.`;
}

export interface SshMachineReadiness {
  node: import("@internal/node-admin").Node;
  canConnect: boolean;
  canConfigure: boolean;
  blockers: { code: string; message: string }[];
}
