import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { apiModels } from "@/schema/index.js";
import { detectRuntimeSessionHarnesses, sessionHarnesses } from "@/services/ssh-runtime/harness-detect.js";
import { getPaneIdentityView, openSession, SshRuntimeRefusal } from "@/services/ssh-runtime/sessions.service.js";
import {
  closeSession,
  getSessionView,
  listSessions,
  sessionLaunchHarness,
  sessionLaunchTerminal,
  sessionListDirs,
} from "@/services/ssh-runtime/sessions-lifecycle.js";

/**
 * `/api/ssh-runtime/sessions` - the personal Connect-over-SSH surface (design
 * 2026-10-05 §1/§4/§7): open, view, list, close, list dirs, launch terminal,
 * and the pane-identity read the terminal page draws its trusted line from.
 *
 * The auth is the product's, not the slice's: a signed-in HUMAN session, and
 * within it only the owner's own rows and own nodes. `requireCookieActor`
 * refuses every machine credential (bearer 403 on this family, no MCP door),
 * and the ownership facts are the service's, stated once there: `openSession`
 * requires the caller to really own the connecting node (foreign 404, no
 * admin boost, no share), and every by-id verb reads through the owner's
 * session - a foreign id and a gone id answer the same 404.
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
        : err.code === "session_quota" ||
            err.code === "session_in_use" ||
            err.code === "run_conflict" ||
            err.code === "dir_missing" ||
            err.code === "dir_relative"
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
  // The runtime SENDS this (task 25's hello field, the launch's re-entry
  // prefix); the optional keeps old rows honest (a hello stored before the
  // field existed reads back without it). Published shape says true.
  selfInvoke: t.Optional(
    t.Object({
      command: t.String({
        description: "Absolute program path (or bare name) the pane uses to re-enter the runtime binary",
      }),
      args: t.Array(t.String({ description: "The self-invocation's prefix arguments" }), {
        description: "Arguments placed before the verb (empty for a plain binary)",
      }),
    }),
  ),
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

const LaunchHarnessBodySchema = t.Object({
  prompt: t.Optional(
    t.String({ maxLength: 100000, description: "Optional initial prompt, delivered after the remote agent starts" }),
  ),
  harnessId: t.String({ description: "Harness plugin id to launch (resolved against this plane's manifests)" }),
  presetId: t.Optional(
    t.Nullable(t.String({ description: "The caller's own preset row to launch with; null/absent = presetless" })),
  ),
  cwd: t.String({ description: "Absolute destination working directory (the folder the browser picked)" }),
  cols: t.Optional(t.Number({ description: "Initial columns, when the opener knows one" })),
  rows: t.Optional(t.Number({ description: "Initial rows, when the opener knows one" })),
});

const DetectBodySchema = t.Object({
  harnessIds: t.Optional(
    t.Array(t.String({ description: "One harness plugin id" }), {
      description: "Narrow the probe to these harnesses; absent asks every enabled manifest",
    }),
  ),
});

/** The harnesses view: the hidden runtime row's cached mirror plus the live session's env answers (service: `RuntimeSessionHarnessesView`). */
const HarnessesViewSchema = t.Object({
  sessionId: t.String({ description: "The session id the view is keyed by" }),
  runtimeNodeId: t.String({ description: "The hidden runtime node row the mirror is stored on" }),
  online: t.Boolean({ description: "Whether a live session backs this view right now" }),
  harnesses: t.Array(
    t.Object({
      harnessId: t.String({ description: "Harness plugin id (the detect spec's id)" }),
      harnessName: t.String({
        description: "Display name from the plane's manifest (the id when the plugin is unknown)",
      }),
      installed: t.Boolean({ description: "The destination's binary answer: found and executable there" }),
      binaryPath: t.Nullable(t.String({ description: "Resolved binary path when installed" })),
      rawVersion: t.Nullable(
        t.String({
          description: "Best available version text (plugin-parsed when a parser ran, raw probe output otherwise)",
        }),
      ),
      reason: t.Nullable(
        t.String({ description: 'Why it was not found ("not-on-path" | "override-invalid" | "no-binary")' }),
      ),
      checkedAt: t.Nullable(t.String({ description: "ISO 8601 stamp of the probe" })),
    }),
    { description: "The cached inventory rows (the requested subset when the detect verb named one)" },
  ),
  env: t.Record(t.String({ description: "Manifest-declared env name" }), t.String({ description: "Its value there" }), {
    description:
      "The destination's answers for the plane-named env vars (empty until the first detect; retired with a lost session)",
  }),
});

/** The 403 every machine credential gets on this family (no MCP door for this surface yet). */
const HUMAN_ONLY = "SSH connections are managed from the browser by a signed-in person.";

/**
 * The pane page's trusted identity read (design §7): the destination facts
 * and the connecting machine's NAME, resolved server-side from the rows.
 * Never composed from anything the pane's output claims, and never from
 * user text: the caller sends only the pane id they are already viewing.
 */
const PaneIdentityViewSchema = t.Object({
  sessionId: t.String({ description: "The session that brokered this pane" }),
  status: t.Union([t.Literal("opening"), t.Literal("active"), t.Literal("lost"), t.Literal("closed")], {
    description:
      "Session lifecycle (lost: the line still names the destination; the panes are unavailable, not completed)",
  }),
  alias: t.String({ description: "The config token chosen at review time" }),
  host: t.String({ description: "Destination host as opened" }),
  port: t.Number({ description: "Destination port as opened" }),
  user: t.Nullable(t.String({ description: "Destination account; null = the connecting account's default" })),
  connectingNodeName: t.Nullable(
    t.String({ description: "The broker's machine name; null when that node row has since been deleted" }),
  ),
});

export const sshRuntimeSessionsRoutes = new Elysia({ prefix: "/sessions" })
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => openSession(user.id, body));
    },
    {
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
    },
  )
  .get(
    "/",
    async ({ user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return { sessions: await runtimeCall(() => listSessions(user.id)) };
    },
    {
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
    },
  )
  .get(
    "/by-pane/:subshellId",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => getPaneIdentityView(params.subshellId, user.id));
    },
    {
      params: t.Object({
        subshellId: t.String({ description: "Ordinary subshell id whose node is a runtime session" }),
      }),
      response: {
        200: PaneIdentityViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimePaneIdentity",
        tags: ["ssh-runtime"],
        description:
          "The trusted destination line for one pane opened through an SSH session (session owner only; an ordinary pane or a foreign row reads the same 404)",
      },
    },
  )
  .get(
    "/:id",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => getSessionView(params.id, user.id));
    },
    {
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
    },
  )
  .post(
    "/:id/close",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
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
    async ({ params, body, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => sessionListDirs(params.id, user.id, body.path));
    },
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
    async ({ params, body, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => sessionLaunchTerminal(params.id, user.id, body));
    },
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
  )
  .get(
    "/:id/harnesses",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => sessionHarnesses(params.id, user.id));
    },
    {
      params: t.Object({ id: t.String({ description: "Session id" }) }),
      response: {
        200: HarnessesViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeSessionHarnesses",
        tags: ["ssh-runtime"],
        description:
          "The cached harness inventory for the session's destination (a mirror read: works offline, answers from the hidden runtime node's row)",
      },
    },
  )
  .post(
    "/:id/harnesses/detect",
    async ({ params, body, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => detectRuntimeSessionHarnesses(params.id, user.id, body.harnessIds));
    },
    {
      params: t.Object({ id: t.String({ description: "Session id" }) }),
      body: DetectBodySchema,
      response: {
        200: HarnessesViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeDetectHarnesses",
        tags: ["ssh-runtime"],
        description:
          "Ask the destination runtime what harness binaries and env vars it has NOW, merge the answer into the cached mirror (a runtime predating detect refuses with sshCode detect_unsupported)",
      },
    },
  )
  .post(
    "/:id/launch-harness",
    async ({ params, body, user, actor }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await runtimeCall(() => sessionLaunchHarness(params.id, user.id, body));
    },
    {
      params: t.Object({ id: t.String({ description: "Session id" }) }),
      body: LaunchHarnessBodySchema,
      response: {
        200: t.Object({
          subshellId: t.String({ description: "The ordinary subshell row the runtime launched" }),
          promptDelivered: t.Optional(t.Boolean({ description: "Whether the initial prompt reached the remote pane" })),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeLaunchHarness",
        tags: ["ssh-runtime"],
        description:
          "Open a harness pane on the session (optionally under the caller's own preset): an ordinary subshells row with the MCP registration and reporter hooks baked from the runtime's hello, never a credential (design §5)",
      },
    },
  );
