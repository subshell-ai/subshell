import { t } from "elysia";

/**
 * The response-schema building blocks shared by the `/api/ssh` route family.
 * Each ROUTE still owns its request schemas and the response map it declares
 * (co-location); what lives HERE is the shape more than one route serializes:
 * the frozen connection snapshot (six routes carry one), the run view (five),
 * the grant view, and the named-code union. They mirror `ssh-api-types.ts`
 * field for field - that file is the shape law, this is its Elysia spelling.
 */

/**
 * The named SSH refusal set, as a schema arm (frozen in `ssh-errors.ts`).
 * Written as an explicit tuple rather than `t.Union(SSH_ERROR_CODES.map(...))`
 * because Elysia's `t.Union` return-type inference needs a non-empty tuple to
 * narrow a handler's `MaybePromise<...>`; a `TLiteral[]` array collapses the
 * route's declared return type and makes every consumer of this schema (the
 * resolve and test routes) fall through to "must return a Response". The
 * members mirror `SSH_ERROR_CODES` exactly; the frozen `isSshErrorCode`
 * remains the runtime authority, and a coordinated code addition edits both.
 */
export const SshErrorCodeSchema = t.Union([
  t.Literal("unsupported_setting"),
  t.Literal("config_missing"),
  t.Literal("config_ambiguous"),
  t.Literal("host_key_unknown"),
  t.Literal("host_key_changed"),
  t.Literal("host_key_revoked"),
  t.Literal("key_unavailable"),
  t.Literal("auth_mode_unsupported"),
  t.Literal("proxy_chain_too_long"),
  t.Literal("quota_runs"),
  t.Literal("quota_terminals"),
  t.Literal("storage_full"),
  t.Literal("stale_command"),
  t.Literal("run_conflict"),
  t.Literal("run_unknown"),
  t.Literal("connection_failed"),
  // The session-runtime additions (design 2026-10-05); the header's rule in
  // force: this tuple mirrors `SSH_ERROR_CODES`, so a code addition edits both.
  t.Literal("runtime_missing"),
  t.Literal("session_quota"),
  t.Literal("session_protocol"),
]);

/** One ProxyJump hop: a destination and nothing else (the §2 reviewability rule). */
export const SshHopSchema = t.Object({
  host: t.String({ description: "Hop hostname" }),
  user: t.Nullable(t.String({ description: "Hop user; null = the connecting account's default" })),
  port: t.Number({ description: "Hop port, already resolved (22 when the config omits Port)" }),
});

/** The eight absent-forbidden members, each a literal-null schema (present-non-null is refused by the parser). */
const forbidden = (why: string) => t.Null({ description: `Always null; ${why}` });

/** The approved normalized snapshot, exactly the frozen `SshConnectionSnapshotWire` shape. */
export const SshSnapshotSchema = t.Object({
  alias: t.String({ description: "The config token the human chose (display/review context, never routing input)" }),
  host: t.String({ description: "Resolved destination hostname" }),
  user: t.Nullable(t.String({ description: "Destination user; null = the connecting account's own default" })),
  port: t.Number({ description: "Destination port, resolved (1..65535)" }),
  identityFiles: t.Array(t.String({ description: "Absolute identity file PATH on the connecting node" }), {
    description: "Identity file references (absolute paths, never contents)",
  }),
  certificateFiles: t.Array(t.String({ description: "Absolute certificate file PATH on the connecting node" }), {
    description: "Certificate file references (path-only, like identities)",
  }),
  authAgentSocket: t.Nullable(
    t.String({ description: "Absolute auth-agent socket path from the connecting account's setup" }),
  ),
  knownHostsFiles: t.Array(t.String({ description: "Absolute known-hosts file path" }), {
    description: "Known-hosts files consulted for trust",
  }),
  hostKeyAlias: t.Nullable(t.String({ description: "OpenSSH HostKeyAlias when the config sets one" })),
  proxyJumps: t.Array(SshHopSchema, { description: "Bounded ProxyJump chain, outermost first" }),
  proxyCommand: forbidden("a resolved ProxyCommand makes a snapshot REFUSABLE, never renderable"),
  forwards: forbidden("forwards found at resolution fail setup"),
  tunnels: forbidden("tunnels found at resolution fail setup"),
  localCommands: forbidden("local commands found at resolution fail setup"),
  remoteCommand: forbidden("RemoteCommand found at resolution fails setup"),
  sendEnv: forbidden("SendEnv found at resolution fails setup"),
  setEnv: forbidden("SetEnv found at resolution fails setup"),
  escapes: forbidden("live escape characters fail setup"),
});

const ActorSideSchema = t.Union([t.Literal("human"), t.Literal("agent")]);

/** A stored connection, as every connections read answers it (frozen `SshConnectionView`). */
export const SshConnectionViewSchema = t.Object({
  id: t.String({ description: "Connection id (uuid)" }),
  nodeId: t.String({ description: "Connecting node id (the SPA renders the route via this)" }),
  displayName: t.String({ description: "Human display label" }),
  snapshot: SshSnapshotSchema,
  remoteDir: t.Nullable(t.String({ description: "Remote-directory default; null = destination login default" })),
  revision: t.Number({ description: "Current revision (grants/runs/panes pin their own)" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last revision-bearing update" }),
});

/** A run, as every runs read answers it (frozen `SshRunView`). */
export const SshRunViewSchema = t.Object({
  id: t.String({ description: "Server-allocated opaque run id" }),
  connectionId: t.Nullable(t.String({ description: "Source connection; null after the connection was deleted" })),
  connectionRevision: t.Number({ description: "Connection revision pinned at dispatch" }),
  nodeId: t.Nullable(t.String({ description: "Connecting node id; null after the node was deleted" })),
  snapshot: SshSnapshotSchema,
  initiatedBy: ActorSideSchema,
  status: t.Union([t.Literal("accepted"), t.Literal("running"), t.Literal("completed"), t.Literal("unknown")]),
  cancelRequested: t.Boolean({ description: "Cancellation was requested through the plane" }),
  cancelLocalConfirmed: t.Boolean({
    description: "The local supervised ssh stopped; remote descendants are never confirmed",
  }),
  deadlineHit: t.Boolean({ description: "The execution deadline fired" }),
  deadlineMs: t.Number({ description: "The deadline the run was dispatched with (ms)" }),
  remoteStatus: t.Nullable(t.Number({ description: "Observed remote exit status; null unless observed" })),
  remoteStatusConfirmed: t.Boolean({
    description: "True only for a CONFIRMED remote result; 255 alone never earns it",
  }),
  localExitCode: t.Nullable(t.Number({ description: "Local ssh exit code; null unless it exited" })),
  localExitSignal: t.Nullable(
    t.String({ description: "Signal name that killed the local ssh; null unless signalled" }),
  ),
  command: t.String({
    description: "The command as dispatched (owner and granted pane only; never on logs/audit/pushes)",
  }),
  remoteDir: t.Nullable(t.String({ description: "Remote directory the run started in" })),
  createdAt: t.String({ description: "ISO 8601 dispatch-accepted time" }),
  startedAt: t.Nullable(t.String({ description: "ISO 8601 first running observation; null until then" })),
  finishedAt: t.Nullable(t.String({ description: "ISO 8601 terminal observation; null while accepted/running" })),
});

/** A grant row as reads answer it (frozen `SshGrantView`). */
export const SshGrantViewSchema = t.Object({
  id: t.String({ description: "Grant id (uuid)" }),
  connectionId: t.String({ description: "Granted connection" }),
  connectionRevision: t.Number({ description: "Pinned revision (the edit-invalidates-grants fact)" }),
  subshellId: t.String({ description: "Granted pane" }),
  apiKeyId: t.String({ description: "The pane's key identity the grant is bound to" }),
  grantedByUserId: t.String({ description: "The human who granted it" }),
  grantedAt: t.String({ description: "ISO 8601 grant time" }),
  revokedAt: t.Nullable(t.String({ description: "ISO 8601 revocation time; null = active" })),
  active: t.Boolean({ description: "Mirror of revokedAt === null" }),
});

/** The managed pane as terminal-create answers it (frozen `SshTerminalView`). */
export const SshTerminalViewSchema = t.Object({
  subshellId: t.String({ description: "The new pane's subshell id" }),
  connectionId: t.String({ description: "Connection the terminal connects" }),
  connectionRevision: t.Number({ description: "Revision pinned at open" }),
  initiatedBy: ActorSideSchema,
  controlOwner: ActorSideSchema,
  controlGeneration: t.Number({ description: "Current input generation (node-enforced fence counter)" }),
  logGeneration: t.Number({ description: "Current log generation (rotation cursor namespace)" }),
  createdAt: t.String({ description: "ISO 8601 open time" }),
});
