/**
 * Hand-written mirror of the backend's node view (`api/nodes/node-view.ts →
 * NodeViewSchema`, spec 2026-08-31 §9) — same convention as `types/subshell.ts`
 * (the Treaty client is never imported; see its header note for why).
 *
 * DELIBERATE SUBSET: only what the new-subshell picker and the subshell-card
 * copy need. The wire carries more (os/arch/hostname/lastSeenAt/capabilities/
 * harnesses/inventoryStale/canManage); fields are added here when a screen
 * actually reads them, not before. The list route returns `{ nodes: Node[] }`;
 * invisible nodes are absent from the list and 404 on detail (ids cannot be
 * probed).
 */

/** The caller's effective access to a node (viewer-relative; "none" never has a view). */
export type NodeAccess = "owner" | "edit" | "view";

/** `local` = the control-plane host itself; `agent` = an enrolled machine. */
export type NodeKind = "local" | "agent";

/** Status projection — the live agent socket is authoritative server-side. */
export type NodeStatus = "online" | "offline";

/** One node as the picker renders it — no secrets, no machine keys. */
export interface Node {
  /** Node id (the control-plane host is literally "local") */
  id: string;
  /** Display name (unique per owner) */
  name: string;
  /** Control-plane host vs enrolled agent */
  kind: NodeKind;
  /** Online/offline projection — offline agents cannot be launched onto (409) */
  status: NodeStatus;
  /** The caller's effective access; ANY visible node grants launch (spec §2) */
  access: NodeAccess;
  /**
   * Whether this viewer may start a subshell here — the server's answer.
   *
   * Any share grants it on an agent node. On the control-plane host it is the
   * granted access alone, so switching launching off there applies to admins
   * too and that one node can be visible and unlaunchable at once (spec
   * 2026-09-12). Optional, and read as `!== false`, so an older server that
   * omits it reads as launchable exactly as before.
   */
  canLaunch?: boolean;
  /** subshell version from `ready`, null until first ready */
  agentVersion: string | null;
  /** Node protocol version from `ready`, null until first ready */
  protocolVersion: number | null;
  /**
   * One row per plugin the instance has installed and enabled, crossed with
   * this node's binary detection (spec 2026-09-10) — what the New screen's
   * Agent chips grey by and the default-agent rule reads. Optional like
   * `canLaunch`: a node row from an older server carries no inventory, and
   * "unknown" must read as "block nothing".
   */
  harnesses?: NodeHarness[];
}

/** One harness row of a node view — the fields the launch picker reads. */
export interface NodeHarness {
  /** Harness plugin id */
  harnessId: string;
  /** Plugin display name from the instance store's manifest */
  name: string;
  /** Whether this machine can actually run it (local: live probe; agent: cached detect) */
  installed: boolean;
}
