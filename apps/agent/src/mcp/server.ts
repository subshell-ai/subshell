import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { MoteApi } from "./api-client.js";
import type { IdentityKeyPair } from "./crypto.js";
import { readMcpEnv } from "./env.js";
import { loadOrCreateIdentity } from "./identity-store.js";
import type { ToolApi } from "./tools.js";
import {
  channelMembers,
  createChannel,
  createSession,
  deleteSession,
  describeToolError,
  getSession,
  joinChannel,
  listChannels,
  listProfiles,
  listSessions,
  postChannel,
  readChannel,
  restartSession,
  terminateSession,
  updateSessionNotes,
} from "./tools.js";

/** Wraps a tool result as an MCP text-content payload (JSON-encoded). */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Registers every mote tool on `server`, bound to `api` + `own`. */
export function registerTools(server: McpServer, deps: { api: ToolApi; own: IdentityKeyPair }): void {
  // The SDK hands each handler a ServerContext whose `mcpReq.signal` aborts
  // when the client cancels; forwarding it lets a long-poll read release its
  // backend socket instead of waiting out the slice.
  const guard =
    <A, R>(fn: (args: A, signal?: AbortSignal) => Promise<R>) =>
    async (args: A, ctx: { mcpReq?: { signal?: AbortSignal } }) => {
      try {
        return json(await fn(args, ctx?.mcpReq?.signal));
      } catch (err) {
        // Surface a clean, actionable message instead of a stack trace.
        throw describeToolError(err);
      }
    };

  // --- channels ---
  server.registerTool(
    "mote_list_channels",
    {
      title: "List channels",
      description: "List all cross-session channels on this mote instance.",
      inputSchema: z.object({}),
    },
    guard(() => listChannels(deps)),
  );
  server.registerTool(
    "mote_create_channel",
    {
      title: "Create channel",
      description: "Create a channel and join it (slug: lowercase letters/digits/hyphen).",
      inputSchema: z.object({ name: z.string() }),
    },
    guard(({ name }: { name: string }) => createChannel(deps, name)),
  );
  server.registerTool(
    "mote_join_channel",
    { title: "Join channel", description: "Join an existing channel.", inputSchema: z.object({ name: z.string() }) },
    guard(({ name }: { name: string }) => joinChannel(deps, name)),
  );
  server.registerTool(
    "mote_channel_members",
    {
      title: "Channel members",
      description: "List a channel's members (principal ids).",
      inputSchema: z.object({ name: z.string() }),
    },
    guard(({ name }: { name: string }) => channelMembers(deps, name)),
  );
  server.registerTool(
    "mote_post_channel",
    {
      title: "Post to channel",
      description: "Send an end-to-end-encrypted message to every key-bearing member of a channel.",
      inputSchema: z.object({ name: z.string(), text: z.string(), nudge: z.boolean().optional() }),
    },
    guard(({ name, text, nudge }: { name: string; text: string; nudge?: boolean }) =>
      postChannel(deps, { name, text, nudge }),
    ),
  );
  server.registerTool(
    "mote_read_channel",
    {
      title: "Read channel",
      description:
        "Read and decrypt a channel's messages you are addressed in. wait_seconds long-polls for new ones; since is a sequence cursor.",
      inputSchema: z.object({
        name: z.string(),
        since: z.number().int().min(0).optional(),
        wait_seconds: z.number().int().min(0).max(600).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    },
    guard((args: { name: string; since?: number; wait_seconds?: number; limit?: number }, signal?: AbortSignal) =>
      readChannel(deps, { ...args, signal }),
    ),
  );

  // --- sessions ---
  server.registerTool(
    "mote_list_sessions",
    { title: "List sessions", description: "List your sessions with status and activity.", inputSchema: z.object({}) },
    guard(() => listSessions(deps)),
  );
  server.registerTool(
    "mote_get_session",
    {
      title: "Get session",
      description: "Get one session's details by id.",
      inputSchema: z.object({ id: z.string() }),
    },
    guard(({ id }: { id: string }) => getSession(deps, id)),
  );
  server.registerTool(
    "mote_list_profiles",
    {
      title: "List profiles",
      description: "List the profiles usable to launch a session (pass a profile name to mote_create_session).",
      inputSchema: z.object({}),
    },
    guard(() => listProfiles(deps)),
  );
  server.registerTool(
    "mote_create_session",
    {
      title: "Create session",
      description:
        "Spawn a new agent session from a profile name + working directory; an optional prompt is typed into the harness once it settles.",
      inputSchema: z.object({
        name: z.string().optional(),
        profile: z.string(),
        working_dir: z.string(),
        prompt: z.string().optional(),
      }),
    },
    guard(
      ({
        name,
        profile,
        working_dir,
        prompt,
      }: {
        name?: string;
        profile: string;
        working_dir: string;
        prompt?: string;
      }) => createSession(deps, { name, profile, workingDir: working_dir, prompt }),
    ),
  );
  server.registerTool(
    "mote_restart_session",
    {
      title: "Restart session",
      description:
        "Restart a session in place (same id): kills its process tree and respawns it from the same profile + directory. Calling it on your OWN session terminates you.",
      inputSchema: z.object({ id: z.string() }),
    },
    guard(({ id }: { id: string }) => restartSession(deps, id)),
  );
  server.registerTool(
    "mote_terminate_session",
    {
      title: "Terminate session",
      description: "Kill a running session's process tree and revoke its token.",
      inputSchema: z.object({ id: z.string() }),
    },
    guard(({ id }: { id: string }) => terminateSession(deps, id)),
  );
  server.registerTool(
    "mote_delete_session",
    {
      title: "Delete session",
      description: "Terminate (if running) and delete a session.",
      inputSchema: z.object({ id: z.string() }),
    },
    guard(({ id }: { id: string }) => deleteSession(deps, id)),
  );
  server.registerTool(
    "mote_update_session_notes",
    {
      title: "Update session notes",
      description: "Set or clear a session's operator note.",
      inputSchema: z.object({ id: z.string(), notes: z.string().nullable() }),
    },
    guard(({ id, notes }: { id: string; notes: string | null }) => updateSessionNotes(deps, id, notes)),
  );
}

/** Self-extension cadence: well inside the 7-day token TTL. */
const EXTEND_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Boots the `mote mcp` stdio server: reads env, persists this session's
 * identity, registers its public key with the backend, arms a token-extension
 * timer, and serves the tools over stdio until the client disconnects.
 *
 * Never writes to stdout (the MCP channel) — diagnostics go to stderr.
 */
export async function runMoteMcp(): Promise<void> {
  const env = readMcpEnv();
  const api = new MoteApi({ baseUrl: env.baseUrl, apiKey: env.apiKey });
  const own = await loadOrCreateIdentity(env.dataDir, `sess:${env.sessionId}`);
  // Register/rotate our key so members can seal replies to us. Best-effort: a
  // 409 (identity_required handled server-side only gates create/join) must
  // not stop us from serving read-only tools.
  try {
    await api.req("/api/identities", {
      method: "POST",
      body: { publicKey: own.publicJwk, displayName: env.sessionName },
    });
  } catch (err) {
    process.stderr.write(`mote mcp: identity registration failed: ${describeToolError(err).message}\n`);
  }

  const timer = setInterval(() => {
    void api
      .req(`/api/sessions/${env.sessionId}/extend-token`, { method: "POST" })
      .catch((e: unknown) => process.stderr.write(`mote mcp: token extend failed: ${describeToolError(e).message}\n`));
  }, EXTEND_INTERVAL_MS);
  timer.unref(); // the stdio connection keeps the process alive, not this timer

  const server = new McpServer({ name: "mote", version: "1.0.0" });
  registerTools(server, { api, own });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`mote mcp: ready (session ${env.sessionId})\n`);
}
