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

/**
 * One harness row: instance plugin identity × this node's detection answer.
 * Rows are one per plugin the INSTANCE has installed and enabled (spec
 * 2026-09-10); the node contributes only the binary half.
 */
export interface NodeHarness {
  /** Harness plugin id (e.g. "claude") */
  harnessId: string;
  /** Plugin display name from the instance store's manifest (the row's label) */
  name: string;
  /** local: live binary probe; agent: cached detect answer (false until the first detect lands) */
  installed: boolean;
  /** Installed version from the node's own detection */
  version?: string;
  /** Why the binary was not found, when it was not */
  reason?: "not-on-path" | "override-invalid" | "no-binary";
  /** ISO 8601 stamp of when this entry was probed; absent when no probe has produced one */
  checkedAt?: string;
  /**
   * Why the plugin cannot be used at all — an INSTANCE fact now (it failed to
   * load in the control-plane process, so on every node alike). The wire
   * still carries it; the node card deliberately does not render it, because
   * it is not a fact about one machine. `Settings → Plugins` says it.
   */
  broken?: string;
  /**
   * The instance holds a newer copy of the plugin than the control-plane
   * process is running; a SERVER restart clears it. Instance fact, same
   * rendering rule as `broken`.
   */
  restartRequired?: boolean;
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
   * Whether this viewer may start a subshell here — the SERVER's answer, never
   * re-derived on this side.
   *
   * Any share grants it on an agent node. On the control-plane host it is the
   * granted access alone, so switching launching off there applies to admins
   * too — which is why that one node can be visible and unlaunchable at once
   * (spec 2026-09-12). Optional so a build talking to an older server, which
   * omits it, reads as launchable exactly as it did before.
   */
  canLaunch?: boolean;
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
  /** One row per plugin the INSTANCE has installed and enabled, crossed with this node's binary detection */
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

/**
 * How an agent PROCESS runs, as the agent itself reported it in `ready`.
 *
 * Mirrors `NodeRuntimeReport` in `@internal/subshell-protocol`
 * (`node-frames.ts`) field for field. Not imported from there because this
 * file is the SPA's mirror of the node ROUTE's shape, and the route is free
 * to carry a subset later; the two are kept honest by review, the same way
 * every other type in this directory is.
 *
 * Facts about a process, never about the machine: the control plane holds
 * the report on the live socket and drops it when that goes, so a value here
 * is always current or absent.
 */
export interface NodeRuntime {
  /** ISO 8601 start time of this agent process */
  startedAt: string;
  /** The manager started THIS pid, so exiting is a restart rather than a stop */
  supervised: boolean;
  /** The service manager's view of the agent's unit */
  service: {
    /** The platform's service manager, or null where there is none */
    manager: "launchd" | "systemd" | null;
    /** Whether a service definition for the agent is installed */
    installed: boolean;
    /** Absolute path of the unit/plist, or null when none is installed */
    definitionPath: string | null;
    /** The manager's own word for the unit's state */
    state: string;
    /** The pid the manager believes it started, or null */
    pid: number | null;
    /** Whether the definition starts at login, or null when unknown */
    enabled: boolean | null;
    /** Whether restarting through the definition keeps live panes alive */
    paneSafety: "keeps" | "kills" | "unknown";
  };
  /**
   * The agent's debug-logging switch — the node half of the server's own.
   *
   * `source: "process env"` means `SUBSHELL_DEBUG_LOGGING` forces it on that
   * machine, and the switch renders read-only for the same reason the
   * server's does.
   */
  logging: {
    /** Whether debug-level lines reach the agent's log file */
    debug: boolean;
    /** Which layer decided */
    source: "process env" | "setting" | "default";
  };
  /** The agent's own config file, resolved */
  configPath: string;
  /**
   * The agent's OWN log file — what `GET /api/nodes/:id/logs` serves.
   *
   * Distinct from `logPath`, which is wherever the service manager redirected
   * stdout: a file under launchd, nothing at all under systemd. This one is
   * written by the agent and exists identically everywhere, which is what makes
   * reading a node's log in a browser one behaviour rather than two.
   */
  agentLogPath: string;
  /** The launchd log file; null under systemd */
  logPath: string | null;
  /** The journal command to run when `logPath` is null */
  logHint: string | null;
  /** tmux on the daemon's PATH, or null — without it the node accepts no launches */
  tmuxPath: string | null;
  /** The agent binary this process re-enters */
  binaryPath: string;
}

/** `GET /api/nodes/:id` — the view plus the grant set, ONLY for config-capable viewers (then the key is absent, not null). */
export interface NodeDetail extends Node {
  /** Full grant set (config-capable viewers only) */
  shares?: NodeShare[];
  /**
   * How the agent runs on that machine.
   *
   * Present only when the node is ONLINE, the viewer can configure it (owner
   * or `edit`), and it is an agent node — never `local`. A `view` grantee may
   * launch here; that does not make the path of this machine's config file
   * their business.
   */
  runtime?: NodeRuntime;
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
