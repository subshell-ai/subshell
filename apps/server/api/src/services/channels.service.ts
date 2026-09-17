import { HttpError } from "@/api/auth-guard.js";
import { ChannelNameTakenError } from "@/db/repositories/channels.repository.js";
import { BaseService } from "@/services/base.service.js";
import { nudgeSubshell } from "@/services/channels/nudge.js";
import { notifyPosts } from "@/services/channels/post-bus.js";
import { waitForNewPosts } from "@/services/channels/read-wait.js";
import { clamp } from "@/utils/number.js";

/**
 * Structural + recipient validation of the opaque envelope (spec §6: never
 * parse ct). Inspecting the plaintext `header.kid` of each recipient slot is
 * explicitly sanctioned — apps/docs/content/docs/use/channels.mdx carries
 * the why, and reads already filter on it), and here the kid SET is pinned to the declared `recipientIds`: without
 * it a sender could address `[B]` while sealing only to itself, leaving B a
 * row that open() can never decrypt and that cursor-advancing reads silently
 * skip.
 * @throws HttpError 400 unless the envelope is a well-formed General JWE
 * whose recipient kids equal the deduplicated `recipientIds` exactly.
 */
function validateEnvelope(raw: string, recipientIds: string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "envelope must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new HttpError(400, "envelope must be a JSON object");
  const env = parsed as Record<string, unknown>;
  const recipients = env.recipients;
  const ok =
    typeof env.ciphertext === "string" &&
    typeof env.iv === "string" &&
    typeof env.tag === "string" &&
    Array.isArray(recipients) &&
    recipients.length > 0;
  if (!ok) throw new HttpError(400, "envelope must be a General JWE (ciphertext, iv, tag, recipients[])");
  const kids = new Set<string>();
  for (const entry of recipients as unknown[]) {
    const header = (entry as { header?: unknown } | null)?.header as { kid?: unknown } | undefined;
    const kid = header?.kid;
    if (typeof kid !== "string" || kid.length === 0) {
      throw new HttpError(400, "every envelope recipient slot needs a non-empty header.kid");
    }
    kids.add(kid);
  }
  const declared = new Set(recipientIds);
  const same = kids.size === declared.size && [...kids].every((kid) => declared.has(kid));
  if (!same) throw new HttpError(400, "envelope recipient kids must exactly match recipientIds");
}

/** One entry of the recipient-filtered post log, as returned by reads. */
interface ChannelPostView {
  /** Post id (uuid) */
  id: string;
  /** Per-channel sequence number */
  seq: number;
  /** Author principal label (token-derived) */
  author: string;
  /** General JWE JSON (opaque to the server) */
  envelope: string;
  /** ISO 8601 timestamp */
  createdAt: string;
}

/** Querystring of a long-poll read (`GET /:name/posts`), already numeric-coerced. */
export interface ChannelPostsQuery {
  /** Return posts with seq > since; defaults to the stored cursor. */
  since?: number | undefined;
  /** Long-poll budget in seconds (clamped to 600). */
  wait?: number | undefined;
  /** Max posts to return (cap 500). */
  limit?: number | undefined;
  /** 1 = advance the stored cursor to what was returned. */
  mark?: number | undefined;
}

/**
 * Business logic behind `/api/channels` — cross-subshell channels: global,
 * append-only, E2EE. The server stores and relays opaque General-JWE
 * envelopes; reads are recipient-filtered so a caller only ever receives
 * posts they can decrypt. Membership is public-key registration (sealed
 * delivery reads the roster directly).
 *
 * Same repository calls and `status`-carrying throws as the former
 * monolithic route. The backend NEVER parses envelope ciphertext —
 * `validateEnvelope` is structural plus plaintext-kid checks only (sanctioned
 * by spec §3), and the recipient filter on reads is the security contract.
 */
export class ChannelsService extends BaseService {
  /** Resolves a channel by slug or throws 404. */
  async #requireChannel(name: string) {
    const channel = await this.repos.channels.findByName(name);
    if (!channel) throw new HttpError(404, "Channel not found");
    return channel;
  }

  /** 409 unless the caller principal has registered an identity (sealed needs keys). */
  async #requireIdentity(principalId: string): Promise<void> {
    const identity = await this.repos.identities.findByPrincipal(principalId);
    if (!identity) throw new HttpError(409, "identity_required: register a public key first (POST /api/identities)");
  }

  /**
   * Creates a channel and joins the creator.
   * @throws HttpError 409 when the caller has no registered identity.
   * @throws HttpError 409 when the channel name is already taken.
   */
  async createChannel({
    principal,
    name,
  }: {
    /** Creator principal label (`user:<id>` / `sess:<id>`), never taken from the body. */
    principal: string;
    /** Channel slug. */
    name: string;
  }): Promise<{ id: string; name: string }> {
    await this.#requireIdentity(principal);
    const channels = this.repos.channels;
    try {
      const channel = await channels.create({ id: crypto.randomUUID(), name, createdBy: principal });
      await channels.addMember({ channelId: channel.id, principalId: principal, addedBy: principal });
      return { id: channel.id, name: channel.name };
    } catch (err) {
      if (err instanceof ChannelNameTakenError) throw new HttpError(409, `channel name taken: ${name}`);
      throw err;
    }
  }

  /** Lists all channels with member/post counters. */
  async listChannels() {
    return { channels: await this.repos.channels.listWithCounts() };
  }

  /**
   * Lists a channel's roster with each member's registered public key.
   * @throws HttpError 404 when the channel slug is unknown.
   */
  async listChannelMembers(name: string): Promise<{
    members: { principalId: string; publicKey: string | null; addedAt: string }[];
  }> {
    const channel = await this.#requireChannel(name);
    const members = await this.repos.channels.members(channel.id);
    const identities = await this.repos.identities.findByPrincipals(members.map((m) => m.principalId));
    return {
      members: members.map((m) => ({
        principalId: m.principalId,
        publicKey: identities.get(m.principalId)?.publicKey ?? null,
        addedAt: m.addedAt,
      })),
    };
  }

  /**
   * Joins the caller to a channel (idempotent).
   * @throws HttpError 404 when the channel slug is unknown.
   * @throws HttpError 409 when the caller has no registered identity.
   */
  async joinChannel({ principal, name }: { principal: string; name: string }): Promise<{ joined: true }> {
    const channel = await this.#requireChannel(name);
    await this.#requireIdentity(principal);
    await this.repos.channels.addMember({
      channelId: channel.id,
      principalId: principal,
      addedBy: principal,
    });
    return { joined: true };
  }

  /**
   * Appends an encrypted post to a channel. The envelope's CIPHERTEXT is
   * never parsed; its structure and plaintext recipient kids are validated
   * (and pinned to `recipientIds`), the author must already be a member, and
   * every recipient must already be a member.
   * @throws HttpError 400 when the envelope is malformed or its recipient
   * kids do not match `recipientIds`.
   * @throws HttpError 400 when a recipient is not a channel member.
   * @throws HttpError 403 when the author is not a channel member.
   * @throws HttpError 404 when the channel slug is unknown.
   */
  async postToChannel({
    principal,
    name,
    envelope,
    recipientIds,
    nudge,
  }: {
    /** Author principal label (token-derived). */
    principal: string;
    /** Channel slug. */
    name: string;
    /** General JWE JSON — opaque ciphertext envelope. */
    envelope: string;
    /** Recipient principal labels; every one must already be a member. */
    recipientIds: string[];
    /** Type a heads-up line into running recipient subshell panes (schema default false). */
    nudge: boolean | undefined;
  }): Promise<{ id: string; seq: number }> {
    validateEnvelope(envelope, recipientIds);
    const channels = this.repos.channels;
    const channel = await this.#requireChannel(name);
    const memberIds = new Set((await channels.members(channel.id)).map((m) => m.principalId));
    // Only members may write into the log (MCP's postChannel auto-joins
    // first, so the agent tool is unaffected by this gate).
    if (!memberIds.has(principal)) throw new HttpError(403, `author is not a member of channel: ${name}`);
    for (const recipientId of recipientIds) {
      if (!memberIds.has(recipientId)) throw new HttpError(400, `recipient is not a member: ${recipientId}`);
    }
    const posts = this.repos.channelPosts;
    const { id, seq } = await posts.append({
      channelId: channel.id,
      author: principal,
      envelope,
      recipientIds: [...new Set(recipientIds)],
    });
    notifyPosts(channel.id);
    if (nudge) {
      // Fixed line to RUNNING subshell RECIPIENTS only (spec §9). A pane
      // waiting at its prompt is WOKEN — the line names the tool and is
      // submitted, so the agent reads the post without being told to poll.
      // A mid-turn pane gets the old Enter-less cue (submitting into a busy
      // harness corrupts the turn). Never peer content in either line.
      const subshells = this.repos.subshells;
      for (const recipientId of new Set(recipientIds)) {
        if (!recipientId.startsWith("sess:") || recipientId === principal) continue;
        const row = await subshells.findById(recipientId.slice("sess:".length));
        if (row?.alive !== 1 || !row.tmuxSocket) continue;
        const waiting = row.waitingSince != null;
        const line = waiting
          ? `[#${channel.name}] subshell peer post, read it: call read_channel("${channel.name}")`
          : `[subshell] new post in #${channel.name}`;
        await nudgeSubshell(row.tmuxSocket, row.id, line, { submit: waiting });
      }
    }
    return { id, seq };
  }

  /**
   * Recipient-filtered long-poll read of a channel's encrypted post log —
   * only posts addressed to the caller are ever returned.
   * @throws HttpError 404 when the channel slug is unknown.
   */
  async readChannelPosts({
    principal,
    name,
    query,
    signal,
  }: {
    /** Reader principal label; the visibility filter's sole subject. */
    principal: string;
    /** Channel slug. */
    name: string;
    /** Numeric-coerced querystring (since/wait/limit/mark). */
    query: ChannelPostsQuery;
    /** The request's abort signal — a departing client stops the wait. */
    signal: AbortSignal;
  }): Promise<{ posts: ChannelPostView[]; nextSince: number }> {
    const channel = await this.#requireChannel(name);
    const posts = this.repos.channelPosts;
    // t.Numeric already coerces the querystring; the `??`s restate the
    // schema defaults for the type checker, and the clamps cap the abuse
    // surface (unbounded waits pin sockets).
    const limit = clamp(query.limit ?? 100, 1, 500);
    const mark = query.mark === 1;
    const since = query.since ?? (await posts.getCursor({ channelId: channel.id, principalId: principal }));
    const waitMs = clamp(query.wait ?? 0, 0, 600) * 1000;

    const fetchVisible = () => posts.listVisible({ channelId: channel.id, principalId: principal, since, limit });
    let visible = await fetchVisible();
    if (visible.length === 0 && waitMs > 0) {
      await waitForNewPosts({
        channelId: channel.id,
        // Recipient-filtered wake: an unaddressed post must not collapse
        // this reader's wait into an instant empty return.
        hasNew: async () =>
          (await posts.countVisibleAfter({ channelId: channel.id, principalId: principal, since })) > 0,
        waitMs,
        signal,
      });
      visible = await fetchVisible();
    }
    const nextSince = visible.length > 0 ? visible[visible.length - 1].seq : since;
    if (mark && visible.length > 0) {
      await posts.setCursor({ channelId: channel.id, principalId: principal, lastSeq: nextSince });
    }
    return {
      posts: visible.map((p) => ({
        id: p.id,
        seq: p.seq,
        author: p.author,
        envelope: p.envelope,
        createdAt: p.createdAt,
      })),
      nextSince,
    };
  }

  /**
   * Returns the caller's stored read position and their unread count.
   * @throws HttpError 404 when the channel slug is unknown.
   */
  async getChannelCursor({
    principal,
    name,
  }: {
    principal: string;
    name: string;
  }): Promise<{ lastSeq: number; unread: number }> {
    const channel = await this.#requireChannel(name);
    const posts = this.repos.channelPosts;
    const lastSeq = await posts.getCursor({ channelId: channel.id, principalId: principal });
    const unread = await posts.countVisibleAfter({ channelId: channel.id, principalId: principal, since: lastSeq });
    return { lastSeq, unread };
  }
}
