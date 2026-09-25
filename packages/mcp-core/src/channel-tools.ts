import { DecryptError, open, seal } from "./crypto.js";
import { checkAndPinRecipients } from "./pin-store.js";
import type { ToolDeps } from "./tools.js";

/**
 * The channel half of the `subshell mcp` tools: everything that seals or
 * opens a JWE travels here. The subshell/machine half is in
 * `subshell-tools.ts`; the shared seam (`ToolApi`, `ToolDeps`) and the error
 * guidance live in `tools.ts`.
 */

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

/** `list_channels` */
export async function listChannels(deps: ToolDeps): Promise<ChannelRow[]> {
  return (await deps.api.req<{ channels: ChannelRow[] }>("/api/channels")).channels;
}

/** `create_channel`: creates and joins (the server auto-joins the creator). */
export async function createChannel(deps: ToolDeps, name: string): Promise<{ name: string }> {
  await deps.api.req<{ id: string }>("/api/channels", { method: "POST", body: { name } });
  return { name };
}

/** `join_channel` */
export async function joinChannel(deps: ToolDeps, name: string): Promise<{ joined: boolean }> {
  await deps.api.req(`/api/channels/${encodeURIComponent(name)}/members`, { method: "POST" });
  return { joined: true };
}

/**
 * The REST read behind a channel roster. No MCP tool wraps it since the
 * 2026-09-25 surface trim (`channel_members` was removed): `post_channel`
 * resolves the roster itself and `read_channel` answers who wrote what.
 * Kept because it is the package's honest surface for the route.
 */
export async function channelMembers(deps: ToolDeps, name: string): Promise<Omit<MemberRow, "publicKey">[]> {
  const { members } = await deps.api.req<{ members: MemberRow[] }>(`/api/channels/${encodeURIComponent(name)}/members`);
  return members.map(({ principalId, addedAt }) => ({ principalId, addedAt }));
}

/**
 * `post_channel`: seals `text` to every member that has a public key
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
  // (a first-seen principal is pinned and proceeds). Pure policy: crypto.ts
  // stays key-agnostic. See mcp/pin-store.ts for the trust model.
  checkAndPinRecipients(recipients);
  const { envelope, recipientIds } = await seal(args.text, recipients);
  return await deps.api.req<{ seq: number }>(`${path}/posts`, {
    method: "POST",
    body: { envelope, recipientIds, nudge: args.nudge ?? false },
  });
}

/**
 * `read_channel`: fetches visible (already recipient-filtered) posts
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
