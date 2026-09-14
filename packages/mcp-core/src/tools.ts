import { ApiError } from "./api-client.js";
import type { IdentityKeyPair } from "./crypto.js";
import { DecryptError, open, seal } from "./crypto.js";
import { checkAndPinRecipients } from "./pin-store.js";

/**
 * The tool implementations of `subshell mcp`, factored out of the MCP layer so
 * they are testable without stdio: everything they touch goes through the
 * narrow {@link ToolApi} seam plus the pure crypto module.
 */

/** The request surface the tools need (satisfied by SubshellApi; stubbed in tests). */
export interface ToolApi {
  req<T>(
    path: string,
    init?: { method?: string; body?: unknown; query?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<T>;
}

/** Everything a tool handler closes over. */
export interface ToolDeps {
  api: ToolApi;
  own: IdentityKeyPair;
}

/** One channel as listed by the API. */
interface ChannelRow {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  lastSeq: number;
}

/** One roster entry (publicKey null = member without an identity yet). */
interface MemberRow {
  principalId: string;
  publicKey: string | null;
  addedAt: string;
}

/** One post as returned over REST (envelope still sealed). */
interface PostRow {
  id: string;
  seq: number;
  author: string;
  envelope: string;
  createdAt: string;
}

/** A decrypted post, the shape agents actually see. */
export interface PlainPost {
  seq: number;
  author: string;
  text: string;
  at: string;
}

/** Maps an ApiError to the plain-English guidance agents act on. */
export function describeToolError(err: unknown): Error {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return new Error(
        "subshell: subshell token rejected (revoked or expired); restart this subshell to mint a new one",
      );
    }
    if (err.status === 403) return new Error(`subshell: permission denied: ${err.message}`);
    if (err.status === 404) return new Error(`subshell: not found: ${err.message}`);
    if (err.status === 409) return new Error(`subshell: conflict: ${err.message}`);
    return new Error(`subshell: API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** `list_channels` */
export async function listChannels(deps: ToolDeps): Promise<ChannelRow[]> {
  return (await deps.api.req<{ channels: ChannelRow[] }>("/api/channels")).channels;
}

/** `create_channel` — creates and joins (the server auto-joins the creator). */
export async function createChannel(deps: ToolDeps, name: string): Promise<{ name: string }> {
  await deps.api.req<{ id: string }>("/api/channels", { method: "POST", body: { name } });
  return { name };
}

/** `join_channel` */
export async function joinChannel(deps: ToolDeps, name: string): Promise<{ joined: boolean }> {
  await deps.api.req(`/api/channels/${encodeURIComponent(name)}/members`, { method: "POST" });
  return { joined: true };
}

/** `channel_members` */
export async function channelMembers(deps: ToolDeps, name: string): Promise<Omit<MemberRow, "publicKey">[]> {
  const { members } = await deps.api.req<{ members: MemberRow[] }>(`/api/channels/${encodeURIComponent(name)}/members`);
  return members.map(({ principalId, addedAt }) => ({ principalId, addedAt }));
}

/**
 * `post_channel` — seals `text` to every member that has a public key
 * (including the author, so their own history reads back) and appends.
 * Joins first when not already a member. Peer keys are TOFU-pinned before
 * sealing: a roster key that changed since a previous post throws rather
 * than letting a hostile relay substitute its own key (`SUBSHELL_CHANNEL_PIN=
 * trust` opts out; see mcp/pin-store.ts).
 */
export async function postChannel(
  deps: ToolDeps,
  args: { name: string; text: string; nudge?: boolean },
): Promise<{ seq: number }> {
  const path = `/api/channels/${encodeURIComponent(args.name)}`;
  let { members } = await deps.api.req<{ members: MemberRow[] }>(`${path}/members`);
  if (!members.some((m) => m.principalId === deps.own.principalId)) {
    await joinChannel(deps, args.name);
    ({ members } = await deps.api.req<{ members: MemberRow[] }>(`${path}/members`));
  }
  const recipients = members
    .filter((m): m is MemberRow & { publicKey: string } => m.publicKey !== null)
    .map((m) => ({ principalId: m.principalId, publicJwk: m.publicKey }));
  if (recipients.length === 0) throw new Error(`subshell: channel #${args.name} has no key-bearing members to address`);
  // TOFU pin-check BEFORE sealing: the roster comes from the relay we do not
  // trust, so a peer key that differs from the pinned one aborts the post
  // (a first-seen principal is pinned and proceeds). Pure policy — crypto.ts
  // stays key-agnostic. See mcp/pin-store.ts for the trust model.
  checkAndPinRecipients(recipients);
  const { envelope, recipientIds } = await seal(args.text, recipients);
  return await deps.api.req<{ seq: number }>(`${path}/posts`, {
    method: "POST",
    body: { envelope, recipientIds, nudge: args.nudge ?? false },
  });
}

/**
 * `read_channel` — fetches visible (already recipient-filtered) posts
 * and opens them with this process's keypair. `wait_seconds` long-polls in
 * ≤50 s slices so no MCP client timeout can fire mid-wait. Envelopes that
 * fail to open are counted, not fatal (e.g. key rotated after they were sent).
 */
export async function readChannel(
  deps: ToolDeps,
  args: { name: string; since?: number; wait_seconds?: number; limit?: number; signal?: AbortSignal },
): Promise<{ posts: PlainPost[]; undecryptable: number; nextSince: number }> {
  const path = `/api/channels/${encodeURIComponent(args.name)}/posts`;
  // No explicit `since` → let the server resume from the stored read cursor
  // (which mark=1 advances on every read), so bare repeated reads tail the
  // channel instead of re-fetching the oldest page forever.
  const base: Record<string, unknown> = { limit: args.limit ?? 100, mark: 1 };
  if (args.since !== undefined) base.since = args.since;
  const deadline = Date.now() + Math.max(0, Math.min(args.wait_seconds ?? 0, 600)) * 1000;
  const waitSec = () => Math.max(0, Math.min((deadline - Date.now()) / 1000, 50));
  let data = await deps.api.req<{ posts: PostRow[]; nextSince: number }>(path, {
    query: { ...base, wait: waitSec() },
    signal: args.signal,
  });
  // A wake can also be for posts this reader isn't addressed in (the server
  // predicate is recipient-filtered, but a race can still return early):
  // retry on REAL elapsed wall-clock, never nominal slices, so the budget
  // can't collapse into a spin.
  while (data.posts.length === 0 && Date.now() < deadline && !args.signal?.aborted) {
    data = await deps.api.req<{ posts: PostRow[]; nextSince: number }>(path, {
      query: { ...base, wait: Math.max(1, waitSec()) },
      signal: args.signal,
    });
  }
  const posts: PlainPost[] = [];
  let undecryptable = 0;
  for (const p of data.posts) {
    try {
      posts.push({ seq: p.seq, author: p.author, text: await open(p.envelope, deps.own), at: p.createdAt });
    } catch (err) {
      if (err instanceof DecryptError) undecryptable++;
      else throw err;
    }
  }
  return { posts, undecryptable, nextSince: data.nextSince };
}

/** A subshell as listed by the API (subset the tools surface). */
export interface SubshellRow {
  id: string;
  name: string;
  harnessId: string;
  status: string;
  activity: string;
  workingDir: string;
}

/** A preset row (subset). */
interface PresetRow {
  id: string;
  name: string;
  harnessId: string;
}

/** `list_subshells` */
export async function listSubshells(deps: ToolDeps): Promise<SubshellRow[]> {
  return await deps.api.req<SubshellRow[]>("/api/subshells");
}

/** `get_subshell` */
export async function getSubshell(deps: ToolDeps, id: string): Promise<SubshellRow> {
  return await deps.api.req<SubshellRow>(`/api/subshells/${encodeURIComponent(id)}`);
}

/**
 * `list_presets` — the owner's presets across every agent the INSTANCE offers
 * (the server's list is store-scoped since the 2026-09-13 follow-up: a
 * harness installed and enabled on the instance lists its presets regardless
 * of which node's PATH holds the binary; per-node fit is decided at launch).
 */
export async function listPresets(deps: ToolDeps): Promise<PresetRow[]> {
  const rows = await deps.api.req<PresetRow[]>("/api/presets");
  return rows.map(({ id, name, harnessId }) => ({ id, name, harnessId }));
}

/**
 * `create_subshell` — launches from a harness plugin id with an optional
 * preset NAME resolved within that harness (ids are not shared context).
 * No preset named means no saved settings, which is a complete launch.
 */
export async function createSubshell(
  deps: ToolDeps,
  args: { name?: string; harness: string; preset?: string; workingDir: string; prompt?: string },
): Promise<{ id: string; promptDelivered: boolean }> {
  let presetId: string | undefined;
  if (args.preset !== undefined) {
    // Scope the lookup to the harness: preset names are only unique per harness.
    const presets = await deps.api.req<PresetRow[]>("/api/presets", { query: { harnessId: args.harness } });
    const want = args.preset.toLowerCase();
    // The name is the agent's addressing key, so a tie is REFUSED, never
    // silently won by whichever row sorts first — launching the wrong preset
    // writes the wrong credential layer. Migration 0028 made the tie
    // unreachable on a current instance (a NOCASE unique index), and this
    // stays anyway: the lookup runs over whatever list the SERVER returned,
    // which may be an older instance, and a client cannot check another
    // machine's constraints.
    //
    // Exact spelling wins outright before the tie is even considered: with
    // `Dev` and `DEV` both present, asking for `Dev` names ONE row and the
    // case-insensitive set is the wrong question. Only a genuine collision —
    // the same spelling twice, or several near-spellings and none exact —
    // reaches the refusal.
    const insensitive = presets.filter((p) => p.name.toLowerCase() === want);
    const exact = insensitive.filter((p) => p.name === args.preset);
    const matches = exact.length > 0 ? exact : insensitive;
    if (matches.length === 0) {
      throw new Error(
        `subshell: no preset named '${args.preset}' for harness '${args.harness}'; call list_presets for options`,
      );
    }
    if (matches.length > 1) {
      // Name the SPELLINGS when they differ — with a case-only collision
      // they are the whole actionable content, and "rename them" without
      // them forces a round trip to list_presets to find out what to rename.
      // Identical spellings would render ('dev', 'dev'), which says nothing:
      // there the ids are the only thing that tells the two rows apart.
      const distinct = new Set(matches.map((p) => p.name));
      const spellings =
        distinct.size > 1 ? matches.map((p) => `'${p.name}'`).join(", ") : matches.map((p) => p.id).join(", ");
      throw new Error(
        `subshell: more than one preset named '${args.preset}' for harness '${args.harness}' (${spellings}); rename one, or ask for an exact spelling`,
      );
    }
    presetId = matches[0].id;
  }
  return await deps.api.req<{ id: string; promptDelivered: boolean }>("/api/subshells", {
    method: "POST",
    body: {
      harnessId: args.harness,
      presetId,
      workingDir: args.workingDir,
      name: args.name,
      prompt: args.prompt,
    },
  });
}

/** `restart_subshell` */
export const restartSubshell = (deps: ToolDeps, id: string) =>
  deps.api.req(`/api/subshells/${encodeURIComponent(id)}/restart`, { method: "POST" });
/** `terminate_subshell` */
export const terminateSubshell = (deps: ToolDeps, id: string) =>
  deps.api.req(`/api/subshells/${encodeURIComponent(id)}/terminate`, { method: "POST" });
/** `delete_subshell` */
export const deleteSubshell = (deps: ToolDeps, id: string) =>
  deps.api.req(`/api/subshells/${encodeURIComponent(id)}`, { method: "DELETE" });
