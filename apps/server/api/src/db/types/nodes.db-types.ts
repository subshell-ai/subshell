/** Lifecycle status projection of a node (truth = the live agent socket). */
export type NodeStatus = "online" | "offline";
/** Whether a node is the control-plane host or an enrolled agent machine. */
export type NodeKind = "local" | "agent";

/**
 * The control-plane host row id (spec 2026-08-31 §2). Single home —
 * repositories AND services import it from this type file (a repository must
 * never import from services/).
 *
 * TRUTH (phase boundary): phase 0 ships SCHEMA ONLY — no `local` row exists
 * yet. The row (owner: system user) and its Everyone/edit share are SEEDED AT
 * PHASE-1 BOOT (`ensureLocalNode`, phase 1A). Until then this constant is a
 * column DEFAULT value and a partition key for `recent_paths`/`subshells`
 * (every pre-nodes row means 'local'), not a pointer to a live `nodes` row.
 */
export const LOCAL_NODE_ID = "local";

/**
 * Database table schema for nodes (spec 2026-08-31 §6.1).
 */
export interface NodeTable {
  /** Node id (uuid); the seeded control-plane host is literally 'local' */
  id: string;
  /** Owning user (system user for 'local') */
  ownerUserId: string;
  /** Display name, unique per owner */
  name: string;
  /** 'local' | 'agent' */
  kind: NodeKind;
  /** Reported OS ('linux' | 'darwin' | …), null until first ready */
  os: string | null;
  /** Reported CPU arch ('x64' | 'arm64' | …) */
  arch: string | null;
  /** Reported hostname */
  hostname: string | null;
  /** Persisted status projection; the live socket is authoritative */
  status: NodeStatus;
  /** ISO 8601 of the last heartbeat/ready */
  lastSeenAt: string | null;
  /** subshell version from `ready` */
  agentVersion: string | null;
  /** Node protocol version from `ready` */
  protocolVersion: number | null;
  /** Agent identity public JWK (pinned at enroll) */
  publicKey: string | null;
  /** better-auth apikey id bound to this node (anti-forgery link) */
  apiKeyId: string | null;
  /** JSON array of capability strings from `ready` */
  capabilities: string | null;
  /** Cached harness inventory (JSON), see inventory TTL in spec §6.2 */
  inventoryJson: string | null;
  /**
   * The node's own report of the plugins it has INSTALLED, as JSON.
   *
   * Null means it has never reported, which is NOT the same as offering
   * nothing: only a node speaking protocol v6 reports at all. Separate from
   * `inventoryJson` because that column holds a harness array with its own
   * parser, and folding two shapes into one would mean changing a parser the
   * launch gate depends on.
   */
  pluginsJson: string | null;
  /** ISO 8601 when pluginsJson was captured */
  pluginsAt: string | null;
  /** ISO 8601 when inventoryJson was captured */
  inventoryAt: string | null;
  /** ISO 8601 creation time */
  createdAt: string;
  /** ISO 8601 last update time */
  updatedAt: string;
}

/** Insert payload: identity fields required, everything machine-reported optional. */
export type NewNode = Pick<NodeTable, "id" | "ownerUserId" | "name" | "kind"> &
  Partial<Omit<NodeTable, "id" | "ownerUserId" | "name" | "kind" | "updatedAt">> & {
    /** ISO 8601 creation time (default: now, set by the repository) */
    createdAt?: string;
  };
