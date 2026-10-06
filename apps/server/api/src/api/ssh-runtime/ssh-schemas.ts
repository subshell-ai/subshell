import { t } from "elysia";

/**
 * The response-schema building blocks of the `/api/ssh-runtime` node verbs
 * (re-homed from the retired `/api/ssh` family by Workstream C; design
 * 2026-10-05 §7). What remains is the shape the wizard's resolve review and
 * refusal mapping need: the named-code union and the approved normalized
 * snapshot. The connection/run/grant/terminal views died with their routes.
 */

/**
 * The named SSH refusal set, as a schema arm (frozen in `ssh-errors.ts`).
 * Written as an explicit tuple rather than `t.Union(SSH_ERROR_CODES.map(...))`
 * because Elysia's `t.Union` return-type inference needs a non-empty tuple to
 * narrow a handler's `MaybePromise<...>`; a `TLiteral[]` array collapses the
 * route's declared return type and makes every consumer of this schema fall
 * through to "must return a Response". The members mirror `SSH_ERROR_CODES`
 * exactly; the frozen `isSshErrorCode` remains the runtime authority, and a
 * coordinated code addition edits both.
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

/** One ProxyJump hop: a destination and nothing else (the reviewability rule). */
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
