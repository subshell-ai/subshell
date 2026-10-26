import { t } from "elysia";

/**
 * The wire views of the `/api/ssh` surface, shared by the routes that carry
 * them (the resolve outcome rides its own endpoint, the launch's 422, and the
 * preset save's 422; the recent-destination row rides GET). One definition per
 * shape — the schemas are the API contract, and two copies of a contract
 * drift.
 */

/**
 * One user-declared port-forward row's ENVELOPE (spec 2026-10-15), shared by
 * the launch body and the preset save because they carry the same thing.
 * Deliberately NOT the detailed grammar: `parseSshForwardRows` in the protocol
 * package is the single authority (host forms, kind rules, duplicate listens),
 * and the renderer re-runs that parser at the last station before bytes - a
 * second grammar in a schema here would be two that drift.
 */
export const SshForwardRowSchema = t.Object({
  kind: t.Union([t.Literal("local"), t.Literal("remote"), t.Literal("dynamic")], {
    description:
      "local: bind a port on the connecting machine that reaches a host the destination can see; remote: ask the destination to bind a port that reaches a host the connecting machine can see; dynamic: a SOCKS proxy on the connecting machine",
  }),
  listenPort: t.Number({
    minimum: 1,
    maximum: 65535,
    description: "Port to bind (always explicit; no auto ports). Integer-ness belongs to the protocol parser",
  }),
  bindHost: t.Nullable(
    t.String({
      minLength: 1,
      maxLength: 253,
      description:
        "Address to bind (hostname, IPv4, or bracketed IPv6). Null means loopback for local/dynamic, and the destination's own policy for remote",
    }),
  ),
  targetHost: t.Nullable(
    t.String({
      minLength: 1,
      maxLength: 253,
      description: "Host to reach through the connection; required for local/remote, null for dynamic",
    }),
  ),
  targetPort: t.Nullable(
    t.Number({ minimum: 1, maximum: 65535, description: "Port on the target host; same kind rule" }),
  ),
});

/**
 * The same forward row as the preset routes carry it, deliberately FLATTER
 * than {@link SshForwardRowSchema}: nested literal unions inside the
 * agent-or-ssh body/response union push the `presets.route.ts` handlers past
 * Elysia's inference depth (measured the day `forwards` arrived; the launch
 * route, which never unions with agent bodies, keeps the expressive kind
 * census). The protocol parser enforces the kind set either way, so the
 * pattern here is documentation, not the enforcement.
 */
export const SshForwardRowInputSchema = t.Object({
  kind: t.String({ pattern: "^(local|remote|dynamic)$", description: "local (-L), remote (-R), or dynamic (-D)" }),
  listenPort: t.Number({ minimum: 1, maximum: 65535, description: "Port to bind (always explicit; no auto ports)" }),
  bindHost: t.Nullable(
    t.String({
      minLength: 1,
      maxLength: 253,
      description: "Address to bind; null means loopback for local/dynamic, the destination's policy for remote",
    }),
  ),
  targetHost: t.Nullable(
    t.String({
      minLength: 1,
      maxLength: 253,
      description: "Host to reach through the connection; required for local/remote, null for dynamic",
    }),
  ),
  targetPort: t.Nullable(
    t.Number({ minimum: 1, maximum: 65535, description: "Port on the target host; same kind rule" }),
  ),
});

/** One ProxyJump hop as the frozen snapshot spells it. */
export const SshHopViewSchema = t.Object({
  host: t.String({ description: "Hop hostname (bracketed IPv6 literal kept as given)" }),
  user: t.Nullable(t.String({ description: "Hop user; null means the connecting account's own default" })),
  port: t.Number({ description: "Hop port, resolved" }),
});

/** The approved connection snapshot, exactly as `SshConnectionSnapshotWire` serializes. */
export const SshSnapshotViewSchema = t.Object({
  alias: t.String({ description: "The config token the human chose (display and review context only)" }),
  host: t.String({ description: "Resolved destination hostname" }),
  user: t.Nullable(t.String({ description: "Destination user; null means the connecting account's own default" })),
  port: t.Number({ description: "Destination port, resolved (1..65535)" }),
  identityFiles: t.Array(t.String({ description: "Absolute identity-file path on the connecting machine" }), {
    description: "Identity file references (paths, never key contents)",
  }),
  certificateFiles: t.Array(t.String({ description: "Absolute certificate-file path on the connecting machine" }), {
    description: "Certificate file references (paths only)",
  }),
  authAgentSocket: t.Nullable(t.String({ description: "Absolute agent-socket path; null runs with no agent" }), {
    description: "The authentication-agent socket to use, or null",
  }),
  knownHostsFiles: t.Array(t.String({ description: "Absolute known-hosts path on the connecting machine" }), {
    description: "Known-hosts files to consult (paths only)",
  }),
  hostKeyAlias: t.Nullable(t.String({ description: "OpenSSH HostKeyAlias when the config sets one" }), {
    description: "The name strict host checking looks up, or null",
  }),
  proxyJumps: t.Array(SshHopViewSchema, { description: "Bounded ProxyJump chain, outermost first" }),
  proxyCommand: t.Null({
    description: "Always null: a resolved ProxyCommand makes a destination refusable, never renderable",
  }),
  forwards: t.Null({ description: "Always null: any resolved forwarding refuses the snapshot" }),
  tunnels: t.Null({ description: "Always null: any resolved tunnel refuses the snapshot" }),
  localCommands: t.Null({ description: "Always null: any resolved local command refuses the snapshot" }),
  remoteCommand: t.Null({ description: "Always null: a resolved RemoteCommand refuses the snapshot" }),
  sendEnv: t.Null({
    description: "Always null: config SendEnv is dropped at normalization; environment never rides the link",
  }),
  setEnv: t.Null({
    description: "Always null: config SetEnv is dropped at normalization; environment never rides the link",
  }),
  escapes: t.Null({ description: "Always null: live escape characters refuse the snapshot" }),
});

/** The `accepted:false` arm: a successful answer whose CONTENT is a refusal. */
export const SshResolveRefusalViewSchema = t.Object({
  accepted: t.Literal(false, {
    description: "Resolution refused: the config needs more than the approved normalization can run",
  }),
  code: t.String({
    description:
      "The named limitation (SshErrorCode): unsupported_setting, config_missing, config_ambiguous, proxy_chain_too_long, host_key_unknown, …",
  }),
  settings: t.Array(
    t.String({ description: "Config keyword that blocked acceptance (a ProxyCommand row, a LocalForward row, …)" }),
    {
      description: "What blocked; empty when the code names the whole cause",
    },
  ),
});

/** `POST /api/ssh/resolve`'s answer: the tier-1 outcome, refusal IN THE DATA. */
export const SshResolveOutcomeViewSchema = t.Union([
  t.Object(
    {
      accepted: t.Literal(true, { description: "The destination normalized cleanly into an approved snapshot" }),
      snapshot: SshSnapshotViewSchema,
      connectingAccount: t.Optional(
        t.String({
          description: "The connecting account's OS user name, when the machine could report it (display only)",
        }),
      ),
    },
    { description: "An approved snapshot the human reviews, then saves or launches" },
  ),
  SshResolveRefusalViewSchema,
]);

/** One recent destination as its owner sees it. */
export const SshRecentDestinationViewSchema = t.Object({
  id: t.String({ description: "Row id (uuid)" }),
  destination: t.String({ description: "Canonical host:port (or user@host:port), the resolved destination as key" }),
  alias: t.Nullable(t.String({ description: "Display token (the alias typed or discovered); never a key" })),
  nodeId: t.String({ description: "The connecting machine of the most recent launch to this destination" }),
  lastConnectAt: t.String({ description: "ISO 8601 of the most recent launch to this destination" }),
});

/** The shared destination-field schema (1..253 chars; the deeper shape rule lives in the service, next to the resolve that enforces it). */
export const SshDestinationField = t.String({
  minLength: 1,
  maxLength: 253,
  description:
    "Destination token: an alias from the machine's config or a concrete host. Same path either way: it is resolved on the connecting machine before anything launches.",
});

/**
 * One public agent identity from the key home's live roster (spec 2026-10-08
 * §5.4, Tasks 11/18): the shape BOTH roster reads answer with - the
 * request-scoped one behind the approval screen and the roster-by-node read
 * behind the create picker. The two fields are the whole of it, by
 * construction: the key BLOBS are withheld on the machine, and this schema is
 * where the wire restates that there is nowhere for one to ride.
 */
export const SshAgentIdentityViewSchema = t.Object({
  fingerprint: t.String({
    description:
      "Public agent identity in the canonical SHA256: notation (the approval body sends these back verbatim)",
  }),
  comment: t.String({ description: "OpenSSH's label for the key, as the agent reports it (display only)" }),
});

/** Optional canonical constraint for destinations restored from an SSH preset. */
export const SshExpectedDestinationField = t.Optional(
  t.String({
    minLength: 1,
    maxLength: 253,
    description: "Expected canonical user@host:port from a saved preset; refuse changed resolution before effects",
  }),
);
