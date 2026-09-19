/**
 * Shared node view model — the hand-written mirror of the backend's
 * `node-view.ts → NodeViewSchema` (spec 2026-08-31 §9), mirroring how
 * `types/subshell.ts` mirrors `toSubshellView`. Field names must match the
 * wire exactly; the list route returns `{ nodes: Node[] }`, the detail route
 * adds `shares` for config-capable viewers.
 */
import type { HeldReason } from "./updates";

/** The caller's effective access to a node (viewer-relative; "none" never has a view). */
export type NodeAccess = "owner" | "edit" | "view";

/** `local` = the control-plane host itself; `agent` = an enrolled machine. */
export type NodeKind = "local" | "agent";

/** Status projection — the live node socket is authoritative server-side. */
export type NodeStatus = "online" | "offline";

/**
 * Which end declared the current maintenance state (spec 2026-09-14 §2).
 *
 * One flag, settable from either end: `plane` means someone threw the switch
 * in a browser, `node` means someone ran `subshell maintenance` at the
 * machine itself. The distinction is not decoration — it is the difference
 * between "I did this" and "somebody is standing at that machine", which is
 * exactly what an owner looking at the card needs to know before undoing it.
 */
export type MaintenanceSource = "plane" | "node";

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
   * (spec 2026-09-12). The server's own `NodeViewSchema` requires it, so it
   * rides every node view there is — this type states the wire rather than
   * hedging against a payload that cannot arrive.
   */
  canLaunch: boolean;
  /**
   * Directories subshells may be created under on this node.
   *
   * **EMPTY MEANS UNRESTRICTED**, never "nothing permitted" — the state every
   * node starts in. Readable by anyone who can see the node (a refused
   * directory is unexplainable without it); only the owner may change it,
   * which `canManage` gates.
   *
   * The server's schema requires the array, so absence is not a state that can
   * arrive: an empty list is the whole of the unrestricted case, and reading
   * one is never a question of whether the field came.
   */
  allowedDirs: string[];
  /** Capability strings from `ready` (empty when none reported) */
  capabilities: string[];
  /** One row per plugin the INSTANCE has installed and enabled, crossed with this node's binary detection */
  harnesses: NodeHarness[];
  /** The node's cached inventory is older than the TTL (or never landed) — installed values are last-known. local: always false */
  inventoryStale: boolean;
  /**
   * Whether this machine is holding new work off while somebody works on it
   * (spec 2026-09-14).
   *
   * A property of the NODE, not of its shares: shares answer WHO may launch,
   * this answers WHETHER ANYONE may, and the two compose by AND. The server
   * has already done that AND — `canLaunch` is false for every viewer of a
   * node in maintenance — so nothing on this side re-derives the gate. The
   * flag rides the list view anyway because `canLaunch: false` alone cannot
   * tell a machine under maintenance from a host narrowed by its shares, and
   * the two owe the reader different words and different ways out.
   *
   * Only launching is refused: service control, logs, detection, restart and
   * config all keep answering.
   */
  maintenance: boolean;
  /** ISO 8601 of the flip that produced the current state; null on a node that has never been flipped */
  maintenanceAt: string | null;
  /** Which end declared it; null when it has never been declared */
  maintenanceSource: MaintenanceSource | null;
  /**
   * This node is connected but REFUSED — held open for exactly one
   * command and offline for every other purpose (spec 2026-09-15 §5.3).
   *
   * The state replaces being dropped. Before, a node below the version floor
   * or speaking a different protocol was closed 4406, so the row read as an
   * ordinary offline node and the only remedy was a shell on that machine.
   * Held, `POST /api/nodes/:id/update` can still reach it — which is why this
   * field is worth rendering: `status: "offline"` alone cannot tell a machine
   * that is powered down from one sitting there waiting to be fixed.
   *
   * Visible to every viewer who can see the row, deliberately unlike
   * `runtime`: it is the same disclosure as the `agentVersion` beside it, not
   * a machine's paths and pids.
   */
  held: NodeHeld | null;
}

/** Why a node is held rather than live. */
export interface NodeHeld {
  /**
   * Which gate refused it: its version, or the wire protocol it speaks.
   *
   * The union lives in `types/updates.ts` beside the card that renders its
   * copy — one definition, so a third reason added to the backend cannot be
   * half-known here.
   */
  reason: HeldReason;
  /** The version reported on the socket being held */
  agentVersion: string;
}

/**
 * `PUT /api/nodes/:id/maintenance` — the node view plus what the act actually
 * did (the mirror of the backend's `MaintenanceResponseSchema`).
 *
 * It extends the BASE view rather than the detail one: the route answers
 * `toNodeView` plus these two fields, so `shares`, `runtime` and
 * `runningSubshells` never ride it. Declaring them here would teach every
 * caller that a field exists which never arrives — the same over-advertising
 * the route's own schema was narrowed to stop.
 *
 * `failed` is the half a caller must never drop. A subshell whose kill the
 * node refused is deliberately NOT in `stopped`, because someone told a pane
 * is down walks away from a machine that is still running it — so a flip that
 * reports refusals has to say so where the person is looking. It rides the
 * response only when it is non-empty, which makes its ABSENCE the clean case
 * rather than a length to compare against zero.
 */
export interface MaintenanceResult extends Node {
  /** Subshell ids this act retired, across every owner; empty when it ended maintenance */
  stopped: string[];
  /** Subshell ids whose kill the node refused — still alive on that machine, never counted as stopped */
  failed?: string[];
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
 * How the node PROCESS runs, as the node itself reported it in `ready`.
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
  /** ISO 8601 start time of this node process */
  startedAt: string;
  /** The manager started THIS pid, so exiting is a restart rather than a stop */
  supervised: boolean;
  /** The service manager's view of the node's unit */
  service: {
    /** The platform's service manager, or null where there is none */
    manager: "launchd" | "systemd" | null;
    /** Whether a service definition for the node is installed */
    installed: boolean;
    /** Absolute path of the unit/plist, or null when none is installed */
    definitionPath: string | null;
    /** The manager's own word for the unit's state */
    state: string;
    /** The pid the manager believes it started, or null */
    pid: number | null;
    /** Whether the definition starts at login, or null when unknown */
    enabled: boolean | null;
    /**
     * Linux: whether that machine's OS user lingers, so an enabled unit comes
     * back at BOOT rather than only at login. `null` on macOS, with nothing
     * installed, and when logind did not answer.
     */
    linger: boolean | null;
    /** Whether restarting through the definition keeps live panes alive */
    paneSafety: "keeps" | "kills" | "unknown";
  };
  /**
   * The node's debug-logging switch — the node half of the server's own.
   *
   * `source: "process env"` means `SUBSHELL_DEBUG_LOGGING` forces it on that
   * machine, and the switch renders read-only for the same reason the
   * server's does.
   */
  logging: {
    /** Whether debug-level lines reach the node's log file */
    debug: boolean;
    /** Which layer decided */
    source: "process env" | "setting" | "default";
  };
  /** The node's own config file, resolved */
  configPath: string;
  /**
   * The node's OWN log file — what `GET /api/nodes/:id/logs` serves.
   *
   * Distinct from `logPath`, which is wherever the service manager redirected
   * stdout: a file under launchd, nothing at all under systemd. This one is
   * written by the node and exists identically everywhere, which is what makes
   * reading a node's log in a browser one behaviour rather than two.
   */
  agentLogPath: string;
  /** The launchd log file; null under systemd */
  logPath: string | null;
  /** The journal command to run when `logPath` is null */
  logHint: string | null;
  /** tmux on the daemon's PATH, or null — without it the node accepts no launches */
  tmuxPath: string | null;
  /** The node binary this process re-enters */
  binaryPath: string;
}

/** `GET /api/nodes/:id` — the view plus the grant set, ONLY for config-capable viewers (then the key is absent, not null). */
export interface NodeDetail extends Node {
  /** Full grant set (config-capable viewers only) */
  shares?: NodeShare[];
  /**
   * How the node runs on that machine.
   *
   * Present only when the node is ONLINE, the viewer can configure it (owner
   * or `edit`), and it is an agent node — never `local`. A `view` grantee may
   * launch here; that does not make the path of this machine's config file
   * their business.
   */
  runtime?: NodeRuntime;
  /**
   * Subshells running on this node right now.
   *
   * Present ONLY for a viewer who MANAGES the node (`canManage` — the owner,
   * or an admin on the control-plane host), because the only thing it is for
   * is telling the one person who can start maintenance what that would stop.
   * A `view` or `edit` grantee may well have subshells here; the count is not
   * their business and the field is simply absent for them.
   *
   * It counts parked rows as well as live ones, so render it as "N subshells"
   * and never "N running" — the stronger word claims more than the number
   * supports.
   */
  runningSubshells?: number;
}

/**
 * One setup key in the management list.
 *
 * It carries the KEY. That is the 2026-09-17 node-setup revamp: the mint stopped
 * naming anything (the machine names itself at enroll), so the label that used to
 * title this row named nothing but the row, and an unused key the dialog was
 * closed on could be revoked but not re-read. Single use, 24 h, owner-scoped —
 * `docs/security.md` accounts for the disclosure.
 */
export interface SetupKeyRow {
  /** Setup key id (used for revocation) */
  id: string;
  /** The `nsk_…` key itself — inert once used or expired */
  key: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 expiry timestamp (24 h after creation) */
  expiresAt: string;
  /** ISO 8601 redemption time, null while unused */
  usedAt: string | null;
  /** Node created by redeeming this key, null while unused */
  consumedNodeId: string | null;
}

/** The create-setup-key response — a convenience copy of what the Setup keys list also carries. */
export interface CreatedSetupKey {
  /** Setup key id (for later revocation) */
  id: string;
  /** The setup key — the same text the list below renders */
  key: string;
  /** ISO 8601 expiry (24 h from creation) */
  expiresAt: string;
}

/** The rotate-key response — the plaintext node bearer key is delivered exactly once, here. */
export interface RotatedNodeKey {
  /** Plaintext node bearer key — shown once, then never again (only its hash is stored) */
  nodeKey: string;
  /** Operator guidance: the node's stored config does NOT update itself — re-configure it by hand */
  message: string;
}
