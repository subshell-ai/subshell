/** Lifecycle status projection of a node (truth = the live agent socket). */
export type NodeStatus = "online" | "offline";
/** Whether a node is the control-plane host or an enrolled agent machine. */
export type NodeKind = "local" | "agent";

/**
 * Which end wrote the maintenance value that currently stands
 * (spec 2026-09-14 §2). Not a permission and not a preference: the state is
 * ONE flag settable from either end, and this records where the standing
 * write came from so a person reading the node page learns whether someone
 * at the keyboard declared the window or someone in a browser did.
 */
export type MaintenanceSource = "plane" | "node";

/** Runtime list of {@link MaintenanceSource} — one edit site for both readings. */
export const MAINTENANCE_SOURCES: readonly MaintenanceSource[] = ["plane", "node"];

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
  /**
   * Base64 X25519 public key pinned for link encryption (spec 2026-09-24 §3);
   * null = legacy row (held-updatable until it registers — §5). The sibling of
   * {@link publicKey} and deliberately not derived from it: signing proves
   * commands, this keys the channel — one key, one job.
   */
  encryptPublicKey: string | null;
  /** better-auth apikey id bound to this node (anti-forgery link) */
  apiKeyId: string | null;
  /** JSON array of capability strings from `ready` */
  capabilities: string | null;
  /** Cached harness inventory (JSON), see inventory TTL in spec §6.2 */
  inventoryJson: string | null;
  /** ISO 8601 when inventoryJson was captured */
  inventoryAt: string | null;
  /**
   * 1 = this node accepts no new subshells (spec 2026-09-14). Composes by AND
   * with the shares: shares say who may launch, this says whether anyone may.
   * 0 for every node that never entered a window — including every row that
   * predates the column.
   */
  maintenance: number;
  /**
   * ISO 8601 of the write that produced {@link maintenance}, or null when no
   * window was ever declared. The plane and the machine hold independent
   * copies and either may be written while the other is unreachable, so this
   * stamp — not the flag — is what decides a disagreement on reconnect.
   */
  maintenanceAt: string | null;
  /** Which end wrote the standing value ({@link MaintenanceSource}); null when none has. */
  maintenanceSource: MaintenanceSource | null;
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
