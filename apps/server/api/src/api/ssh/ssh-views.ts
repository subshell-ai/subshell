import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { t } from "elysia";
import type { SshRefusal } from "@/services/ssh-launch.service.js";

/**
 * The wire views of the `/api/ssh` surface, shared by the routes that carry
 * them (the resolve outcome rides its own endpoint, the launch's 422, and the
 * save's 422; the saved-host row rides GET and PUT). One definition per
 * shape — the schemas are the API contract, and two copies of a contract
 * drift.
 */

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
  sendEnv: t.Null({ description: "Always null: a resolved SendEnv refuses the snapshot" }),
  setEnv: t.Null({ description: "Always null: a resolved SetEnv refuses the snapshot" }),
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

/** One saved/recency row as its owner sees it. */
export const SshSavedHostViewSchema = t.Object({
  id: t.String({ description: "Row id (uuid)" }),
  destination: t.String({ description: "Canonical host:port (or user@host:port), the resolved destination as key" }),
  alias: t.Nullable(t.String({ description: "Display token (the alias typed or discovered); never a key" })),
  nodeId: t.String({ description: "The connecting machine of the most recent launch to this destination" }),
  savedAt: t.Nullable(t.String({ description: "ISO 8601 the human saved it; null = recency-only row" })),
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
 * Throw a CODED service refusal as the structured `ApiError` the global
 * handler serializes (the `NODE_IN_MAINTENANCE` posture: an expected refusal
 * mapped at the service boundary, doNotLog so the 4xx never fills the error
 * log). The status rides the code's own definition, and every code here is
 * defined with exactly the status the gate doctrine gives it (403 gate, 404
 * invisible, 409 held/offline, 400 unsafe token, 502 machine-refused) — the
 * pairing is in `error-codes.ts`, not re-derived here.
 *
 * The 422 arm — the resolve outcome an ACTING endpoint refuses — is NOT an
 * error envelope (its body is `{outcome}`) and belongs to the `status(422,…)`
 * return of the launch/save routes; reaching this helper with one is a
 * routing bug in this file's own callers, so it answers 500 rather than
 * inventing a body.
 */
export function throwCodedRefusal(refusal: SshRefusal): never {
  if (refusal.status === 422) {
    throwApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "SSH refusal routed to the wrong surface",
    });
  }
  throwApiError({ code: refusal.code, message: refusal.message, doNotLog: true });
}
