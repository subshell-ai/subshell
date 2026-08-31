import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { ChannelPostsRepository } from "@/db/repositories/channel-posts.repository.js";
import { ChannelNameTakenError, ChannelsRepository } from "@/db/repositories/channels.repository.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";

/** Clears every channels-feature table (FK-safe order). */
async function wipe(): Promise<void> {
  await db.deleteFrom("channelCursors").execute();
  await db.deleteFrom("channelPostRecipients").execute();
  await db.deleteFrom("channelPosts").execute();
  await db.deleteFrom("channelMembers").execute();
  await db.deleteFrom("channels").execute();
  await db.deleteFrom("identities").execute();
}

describe("ChannelsRepository", () => {
  const repo = new ChannelsRepository(db);

  beforeEach(wipe);

  it("creates and finds by name (case-folded slug)", async () => {
    const created = await repo.create({ id: "c1", name: "refactor", createdBy: "user:me" });
    expect(created.name).toBe("refactor");
    const found = await repo.findByName("refactor");
    expect(found?.id).toBe("c1");
    expect(await repo.findByName("nope")).toBeUndefined();
  });

  it("rejects duplicate names with ChannelNameTakenError", async () => {
    await repo.create({ id: "c1", name: "dup", createdBy: "user:me" });
    await expect(repo.create({ id: "c2", name: "dup", createdBy: "user:other" })).rejects.toThrow(
      ChannelNameTakenError,
    );
  });

  it("addMember is idempotent and members() lists principals", async () => {
    await repo.create({ id: "c1", name: "x", createdBy: "user:me" });
    await repo.addMember({ channelId: "c1", principalId: "sess:a", addedBy: "user:me" });
    await repo.addMember({ channelId: "c1", principalId: "sess:a", addedBy: "user:me" });
    const members = await repo.members("c1");
    expect(members.length).toBe(1);
    expect(members[0].principalId).toBe("sess:a");
  });

  it("listWithCounts reports memberCount and lastSeq", async () => {
    await repo.create({ id: "c1", name: "x", createdBy: "user:me" });
    await repo.addMember({ channelId: "c1", principalId: "sess:a", addedBy: "user:me" });
    const posts = new ChannelPostsRepository(db);
    await posts.append({ channelId: "c1", author: "sess:a", envelope: "{}", recipientIds: ["sess:a"] });
    const list = await repo.listWithCounts();
    expect(list[0]).toMatchObject({ id: "c1", memberCount: 1, lastSeq: 1 });
  });
});

describe("IdentitiesRepository", () => {
  const repo = new IdentitiesRepository(db);

  beforeEach(wipe);

  it("registers and upserts (rotate) by principal", async () => {
    const first = await repo.register({ principalId: "sess:a", publicKey: "JWK-1", displayName: "Alpha" });
    expect(first.publicKey).toBe("JWK-1");
    const rotated = await repo.register({ principalId: "sess:a", publicKey: "JWK-2", displayName: null });
    expect(rotated.publicKey).toBe("JWK-2");
    expect(await repo.findByPrincipal("sess:a")).toMatchObject({ publicKey: "JWK-2", displayName: null });
    expect(await repo.findByPrincipal("sess:ghost")).toBeUndefined();
  });
});

describe("ChannelPostsRepository", () => {
  const channels = new ChannelsRepository(db);
  const posts = new ChannelPostsRepository(db);

  beforeEach(async () => {
    await wipe();
    await channels.create({ id: "c1", name: "x", createdBy: "user:me" });
  });

  it("append assigns monotonic per-channel seq", async () => {
    const a = await posts.append({ channelId: "c1", author: "user:me", envelope: "e1", recipientIds: ["user:me"] });
    const b = await posts.append({ channelId: "c1", author: "user:me", envelope: "e2", recipientIds: ["user:me"] });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(await posts.maxSeq("c1")).toBe(2);
  });

  it("listVisible returns only posts where the principal is a recipient", async () => {
    const mine = await posts.append({ channelId: "c1", author: "a", envelope: "m", recipientIds: ["p-me", "p-other"] });
    await posts.append({ channelId: "c1", author: "b", envelope: "hidden", recipientIds: ["p-other"] });
    const visible = await posts.listVisible({ channelId: "c1", principalId: "p-me", since: 0, limit: 50 });
    expect(visible.length).toBe(1);
    expect(visible[0].id).toBe(mine.id);
    expect(visible[0].envelope).toBe("m");
  });

  it("listVisible honors since (cursor) and asc order", async () => {
    await posts.append({ channelId: "c1", author: "a", envelope: "one", recipientIds: ["p"] });
    const two = await posts.append({ channelId: "c1", author: "a", envelope: "two", recipientIds: ["p"] });
    const after = await posts.listVisible({ channelId: "c1", principalId: "p", since: 1, limit: 50 });
    expect(after.map((r) => r.id)).toEqual([two.id]);
  });

  it("cursors default to 0, set, and advance", async () => {
    expect(await posts.getCursor({ channelId: "c1", principalId: "p" })).toBe(0);
    await posts.setCursor({ channelId: "c1", principalId: "p", lastSeq: 5 });
    expect(await posts.getCursor({ channelId: "c1", principalId: "p" })).toBe(5);
    await posts.setCursor({ channelId: "c1", principalId: "p", lastSeq: 3 }); // never goes backwards
    expect(await posts.getCursor({ channelId: "c1", principalId: "p" })).toBe(5);
  });
});
