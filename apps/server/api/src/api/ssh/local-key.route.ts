import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { isSshKeyBridgePayload, SSH_LOCAL_KEY_MAX_BASE64 } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshDestinationField } from "@/api/ssh/ssh-views.js";
import { closeLocalSshKey, exchangeLocalSshKey, prepareLocalSshKey } from "@/services/ssh-local-key.service.js";

const PrepareSchema = t.Object({
  node: t.String({ minLength: 1, maxLength: 128, description: "Connecting node id" }),
  destination: SshDestinationField,
});
const IdSchema = t.Object({ id: t.String({ format: "uuid", description: "Temporary signing request id" }) });
const ReplySchema = t.Object({
  // The bridge ends itself before a ninth request exists, so 0..7 is every
  // sequence a reply can legitimately carry.
  seq: t.Integer({ minimum: 0, maximum: 7, description: "Outstanding agent request sequence" }),
  payload: t.String({
    minLength: 4,
    maxLength: SSH_LOCAL_KEY_MAX_BASE64,
    pattern: "^[A-Za-z0-9+/]+={0,2}$",
    description: "Public SSH agent reply, standard base64",
  }),
});
const ExchangeSchema = t.Object({ reply: t.Optional(ReplySchema) });

/** Only authenticated browser sessions can route public requests to their native signer. */
export const sshLocalKeyRoutes = new Elysia()
  .use(authGuard)
  .post(
    "/local-key",
    async ({ user, actor, session, body, set }) => {
      requireCookieActor(actor, "Local SSH keys require a browser session.");
      if (!session) throw new Error("Browser session is unavailable.");
      set.headers["cache-control"] = "no-store";
      return prepareLocalSshKey(user.id, session.id, body.node, body.destination);
    },
    {
      body: PrepareSchema,
      detail: {
        tags: ["ssh"],
        description: "Prepare public destination details for a native, one-use SSH key selection.",
      },
    },
  )
  .post(
    "/local-key/:id/exchange",
    async ({ user, actor, session, params, body, set }) => {
      requireCookieActor(actor, "Local SSH keys require a browser session.");
      if (!session) throw new Error("Browser session is unavailable.");
      // Character bounds do not prove the decoded size; check it here, before
      // the frame rides the signed RPC and the node's grammar kills the bridge.
      if (body.reply && !isSshKeyBridgePayload(body.reply.payload))
        throwApiError({
          code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
          message: "The signing reply isn't a valid bounded SSH agent message.",
          doNotLog: true,
        });
      set.headers["cache-control"] = "no-store";
      return exchangeLocalSshKey(params.id, user.id, session.id, body.reply);
    },
    {
      params: IdSchema,
      body: ExchangeSchema,
      detail: {
        tags: ["ssh"],
        description: "Exchange one bounded public SSH-agent message with this session's native signer.",
      },
    },
  )
  .delete(
    "/local-key/:id",
    async ({ user, actor, session, params }) => {
      requireCookieActor(actor, "Local SSH keys require a browser session.");
      if (!session) throw new Error("Browser session is unavailable.");
      await closeLocalSshKey(params.id, { viewerId: user.id, sessionId: session.id });
      return { closed: true };
    },
    {
      params: IdSchema,
      detail: {
        tags: ["ssh"],
        description: "End temporary signing access without stopping an established SSH subshell.",
      },
    },
  );
