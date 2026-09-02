/**
 * Hand-written mirror of the backend's node view (`api/nodes/node-view.ts →
 * NodeViewSchema`, spec 2026-08-31 §9) — same convention as `types/session.ts`
 * (the Treaty client is never imported; see its header note for why).
 *
 * DELIBERATE SUBSET: only what the new-session picker and the session-card
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
  /** subshell version from `ready`, null until first ready */
  agentVersion: string | null;
  /** Node protocol version from `ready`, null until first ready */
  protocolVersion: number | null;
}
