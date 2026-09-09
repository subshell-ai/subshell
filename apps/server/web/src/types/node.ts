/**
 * Shared node view model — the hand-written mirror of the backend's
 * `node-view.ts → NodeViewSchema` (spec 2026-08-31 §9), mirroring how
 * `types/subshell.ts` mirrors `toSubshellView`. Field names must match the
 * wire exactly; the list route returns `{ nodes: Node[] }`, the detail route
 * adds `shares` for config-capable viewers.
 */

/** The caller's effective access to a node (viewer-relative; "none" never has a view). */
export type NodeAccess = "owner" | "edit" | "view";

/** `local` = the control-plane host itself; `agent` = an enrolled machine. */
export type NodeKind = "local" | "agent";

/** Status projection — the live agent socket is authoritative server-side. */
export type NodeStatus = "online" | "offline";

/** One harness row: plugin identity × this node's state. */
export interface NodeHarness {
  /** Harness plugin id (e.g. "claude") */
  harnessId: string;
  /** Explicit per-node state when set, else the plugin's default */
  enabled: boolean;
  /** local: live binary probe; agent: cached inventory (false until the first inventory lands) */
  installed: boolean;
  /** Installed version from the node's own detection */
  version?: string;
  /** Why the binary was not found, when it was not */
  reason?: "not-on-path" | "override-invalid" | "no-binary";
  /** ISO 8601 stamp of when this entry was probed; absent from an older agent */
  checkedAt?: string;
}

/** One node as the registry renders it — no secrets, no machine keys. */
export interface Node {
  /** Node id (the control-plane host is literally "local") */
  id: string;
  /** Display name (unique per owner) */
  name: string;
  /** Control-plane host vs enrolled agent */
  kind: NodeKind;
  /** Reported OS, null until first ready */
  os: string | null;
  /** Reported CPU architecture, null until first ready */
  arch: string | null;
  /** Reported hostname, null until first ready */
  hostname: string | null;
  /** Online/offline projection */
  status: NodeStatus;
  /** ISO 8601 of the last heartbeat/ready, null when never seen */
  lastSeenAt: string | null;
  /** subshell version from `ready`, null until first ready */
  agentVersion: string | null;
  /** Node protocol version from `ready`, null until first ready. Matched EXACTLY against `NODE_PROTOCOL_VERSION`: any mismatch, either direction, is refused at `ready` and the node shows offline with a chip naming which side to redeploy. */
  protocolVersion: number | null;
  /** The caller's effective access (drives which controls render) */
  access: NodeAccess;
  /**
   * Whether the caller manages this node (delete/re-share): real owner, or an
   * admin on `local` — server-derived (the same rule the route gate applies),
   * so the client must never re-derive admin identity.
   */
  canManage: boolean;
  /**
   * Directories subshells may be created under on this node.
   *
   * **EMPTY MEANS UNRESTRICTED**, never "nothing permitted" — the
   * backwards-compatible default every node starts with. Readable by anyone
   * who can see the node (a refused directory is unexplainable without it);
   * only the owner may change it, which `canManage` gates.
   *
   * Optional for the same reason `nodeId` is on SubshellView: a payload cached
   * by a client older than the field must keep typechecking.
   */
  allowedDirs?: string[];
  /** Capability strings from `ready` (empty when none reported) */
  capabilities: string[];
  /** Every registered harness × this node's state */
  harnesses: NodeHarness[];
  /** Agent's cached inventory is older than the TTL (or never landed) — installed values are last-known. local: always false */
  inventoryStale: boolean;
}

/** One sharing grant on a node (mirrors the backend `NodeShareSchema`). */
export interface NodeShare {
  /** Share row id */
  id: string;
  /** Grantee user id, or null for the Everyone grant */
  granteeUserId: string | null;
  /** Grantee display name ("Everyone" for the null grant; the id when the user is gone) */
  granteeName: string | null;
  /** Access level this grant confers */
  permission: "view" | "edit";
}

/** `GET /api/nodes/:id` — the view plus the grant set, ONLY for config-capable viewers (then the key is absent, not null). */
export interface NodeDetail extends Node {
  /** Full grant set (config-capable viewers only) */
  shares?: NodeShare[];
}

/** One setup key in the management list — the secret is never here. */
export interface SetupKeyRow {
  /** Setup key id (used for revocation) */
  id: string;
  /** Human label given at creation */
  label: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 expiry timestamp (24 h after creation) */
  expiresAt: string;
  /** ISO 8601 redemption time, null while unused */
  usedAt: string | null;
  /** Node created by redeeming this key, null while unused */
  consumedNodeId: string | null;
}

/** The create-setup-key response — the plaintext `nsk_` key is delivered exactly once, here. */
export interface CreatedSetupKey {
  /** Setup key id (for later revocation) */
  id: string;
  /** The plaintext setup key — shown once, then never again */
  key: string;
  /** ISO 8601 expiry (24 h from creation) */
  expiresAt: string;
}

/** The rotate-key response — the plaintext node bearer key is delivered exactly once, here. */
export interface RotatedNodeKey {
  /** Plaintext node bearer key — shown once, then never again (only its hash is stored) */
  nodeKey: string;
  /** Operator guidance: the agent's stored config does NOT update itself — re-configure it by hand */
  message: string;
}
