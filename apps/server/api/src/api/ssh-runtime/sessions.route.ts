import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiModels } from "@/schema/index.js";
import { openSession, SshRuntimeRefusal } from "@/services/ssh-runtime/sessions.service.js";
import {
  closeSession,
  getSessionView,
  listSessions,
  sessionLaunchTerminal,
  sessionListDirs,
} from "@/services/ssh-runtime/sessions-lifecycle.js";

/**
 * `/api/ssh-runtime/sessions` - the Gate A slice's plane endpoints (design
 * 2026-10-05 §4/§9): open, view, list, close, list dirs, launch terminal.
 * Cookie-admin only for the slice (`requireAdmin`: machine credentials are
 * refused at the guard): the UX (workstream U) will widen to "anyone may
 * open through their OWN node", which is what the service's real-ownership
 * gate already enforces underneath - the route is the slice's small door,
 * not the product's final one.
 *
 * The refusal mapping (module doc of the service states the equality rule):
 * `SshRuntimeRefusal.status` carries the HTTP code the service decided
 * (404 not-visible, 409 named refusal, 500/502 broken answer), and the named
 * code rides as `metadataSafe.sshCode` - the equality table made visible to
 * any client that wants to branch, never buried in prose.
 */

/** Map a service refusal onto the house ApiError shape, code riding the metadata. */
function refuseRuntime(err: SshRuntimeRefusal): never {
  const code =
    err.status === 404
      ? BackendErrorCodes.NOT_FOUND_ERROR
      : err.status >= 500
        ? BackendErrorCodes.INTERNAL_SERVER_ERROR
        : err.code === "session_quota" || err.code === "run_conflict"
          ? BackendErrorCodes.EXISTS_ERROR
          : BackendErrorCodes.ACCESS_DENIED;
  throwApiError({
    code,
    message: err.message,
    doNotLog: true,
    ...(err.code !== null ? { metadataSafe: { sshCode: err.code } } : {}),
  });
}

/** Run a service call, translating its named refusal and letting anything else stand. */
async function runtimeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SshRuntimeRefusal) refuseRuntime(err);
    throw err;
  }
}

const HelloSchema = t.Object({
  type: t.Literal("hello", { description: "Frame discriminator (the parsed hello object, not a wire frame here)" }),
  runtimeProtocol: t.Number({ description: "The runtime link's protocol (this plane speaks 1)" }),
  agentVersion: t.String({ description: "The destination runtime binary's version" }),
  os: t.String({ description: "Destination OS name as reported" }),
  arch: t.String({ description: "Destination architecture as reported" }),
  capabilities: t.Array(t.String({ description: "One advertised capability label" }), {
    description: "Capability labels the runtime build advertises",
  }),
  homeDir: t.String({ description: "The destination account's home directory" }),
  dataDir: t.String({ description: "The runtime's data dir (a `runtime/` namespace, isolated by design)" }),
  tmuxSocket: t.String({ description: "The deterministic per-destination tmux socket the runtime serves" }),
  paneCount: t.Number({ description: "Panes already on that socket at hello time (the reconcile count)" }),
});

const SessionViewSchema = t.Object({
  id: t.String({ description: "Session id (the plane-minted broker ref)" }),
  connectingNodeId: t.Nullable(
    t.String({ description: "The node that brokered the SSH child; null once that machine row has been deleted" }),
  ),
  runtimeNodeId: t.String({ description: "The hidden runtime node row the session's panes carry" }),
  alias: t.String({ description: "The config token chosen at review time" }),
  host: t.String({ description: "Reviewed destination host" }),
  port: t.Number({ description: "Reviewed destination port" }),
  user: t.Nullable(t.String({ description: "Destination account; null = the connecting account's default" })),
  status: t.Union([t.Literal("opening"), t.Literal("active"), t.Literal("lost"), t.Literal("closed")], {
    description: "Session lifecycle (lost: panes unavailable, not completed)",
  }),
  hello: t.Nullable(HelloSchema),
  createdAt: t.String({ description: "ISO 8601 open requested" }),
  lastSeenAt: t.Nullable(t.String({ description: "ISO 8601 of the last proof of life" })),
  closedAt: t.Nullable(t.String({ description: "ISO 8601 of the terminal transition" })),
});

const OpenBodySchema = t.Object({
  connectingNodeId: t.String({ description: "The enrolled node to broker through (must be the caller's own)" }),
  target: t.Object({
    alias: t.String({ description: "The config token / label for the destination" }),
    host: t.String({ description: "Destination host (reviewed at open; never free shell material)" }),
    port: t.Number({ description: "Destination port, 1..65535" }),
    user: t.Nullable(t.String({ description: "Destination account; null = the connecting account's own default" })),
    identityFile: t.Nullable(
      t.String({ description: "Absolute identity-file ref on the connecting node; null = defaults" }),
    ),
  }),
  runtimeCommand: t.Optional(
    t.String({ description: "Slice seam: program override for the runtime entry point (default `subshell`)" }),
  ),
});

const ListDirsBodySchema = t.Object({
  path: t.String({ description: "Directory to list; empty means the destination account's home" }),
});

const LaunchTerminalBodySchema = t.Object({
  cwd: t.String({ description: "Absolute destination working directory (validated by stat_dir on the destination)" }),
  cols: t.Optional(t.Number({ description: "Initial columns, when the opener knows one" })),
  rows: t.Optional(t.Number({ description: "Initial rows, when the opener knows one" })),
});

export const sshRuntimeSessionsRoutes = new Elysia({ prefix: "/sessions" })
  .use(requireAdmin)
  .use(apiModels)
  .post("/", async ({ body, user }) => await runtimeCall(() => openSession(user.id, body)), {
    body: OpenBodySchema,
    response: {
      200: SessionViewSchema,
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "sshRuntimeOpenSession",
      tags: ["ssh-runtime"],
      description:
        "Open a brokered SSH runtime session through an owned node: probe the destination runtime, spawn the SSH child, and answer with the runtime hello (protocol mismatch and an absent runtime refuse by name)",
    },
  })
  .get("/", async ({ user }) => ({ sessions: await runtimeCall(() => listSessions(user.id)) }), {
    response: {
      200: t.Object({ sessions: t.Array(SessionViewSchema, { description: "The caller's sessions, newest first" }) }),
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
    },
    detail: {
      operationId: "sshRuntimeListSessions",
      tags: ["ssh-runtime"],
      description: "The caller's session history",
    },
  })
  .get("/:id", async ({ params, user }) => await runtimeCall(() => getSessionView(params.id, user.id)), {
    params: t.Object({ id: t.String({ description: "Session id" }) }),
    response: {
      200: SessionViewSchema,
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
    },
    detail: {
      operationId: "sshRuntimeGetSession",
      tags: ["ssh-runtime"],
      description: "One session view (owner only)",
    },
  })
  .post(
    "/:id/close",
    async ({ params, user }) => {
      await runtimeCall(() => closeSession(params.id, user.id));
      return { ok: true as const };
    },
    {
      params: t.Object({ id: t.String({ description: "Session id" }) }),
      response: {
        200: t.Object({
          ok: t.Literal(true, {
            description: "The close was ordered (panes on the destination keep running by design)",
          }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeCloseSession",
        tags: ["ssh-runtime"],
        description: "Close a session: the runtime reports and exits; the destination tmux and its panes stay up",
      },
    },
  )
  .post(
    "/:id/list-dirs",
    async ({ params, body, user }) => await runtimeCall(() => sessionListDirs(params.id, user.id, body.path)),
    {
      params: t.Object({ id: t.String({ description: "Session id" }) }),
      body: ListDirsBodySchema,
      response: {
        200: t.Object({
          path: t.String({ description: "Absolute realpath of the listed directory on the destination" }),
          parent: t.Nullable(t.String({ description: "Parent directory; null at the filesystem root" })),
          entries: t.Array(
            t.Object({
              name: t.String({ description: "Entry name" }),
              path: t.String({ description: "Absolute path of the entry" }),
              kind: t.Literal("dir", { description: "Directories only, dotfiles hidden, like the node-link listing" }),
            }),
            { description: "The listed children, capped like the node-link listing" },
          ),
          truncated: t.Boolean({ description: "True when the cap cut the listing" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeListDirs",
        tags: ["ssh-runtime"],
        description: "One-level directory listing on the destination (the remote picker's read)",
      },
    },
  )
  .post(
    "/:id/launch-terminal",
    async ({ params, body, user }) => await runtimeCall(() => sessionLaunchTerminal(params.id, user.id, body)),
    {
      params: t.Object({ id: t.String({ description: "Session id" }) }),
      body: LaunchTerminalBodySchema,
      response: {
        200: t.Object({ subshellId: t.String({ description: "The ordinary subshell row the runtime launched" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeLaunchTerminal",
        tags: ["ssh-runtime"],
        description:
          "Open a terminal pane on the session: an ordinary subshells row on the hidden runtime node, launched through the framed byte channel",
      },
    },
  );
