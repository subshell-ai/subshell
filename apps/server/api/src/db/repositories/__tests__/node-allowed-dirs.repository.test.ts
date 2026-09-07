import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";

const repo = new NodeAllowedDirsRepository(db);
const NODE = `n-allowed-${crypto.randomUUID()}`;
const OTHER = `n-other-${crypto.randomUUID()}`;

async function seedNode(id: string): Promise<void> {
  await db
    .insertInto("nodes")
    .values({
      id,
      ownerUserId: "u1",
      name: id,
      kind: "agent",
      status: "offline",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never)
    .execute();
}

describe("NodeAllowedDirsRepository", () => {
  beforeAll(async () => {
    await runMigrations();
    await seedNode(NODE);
    await seedNode(OTHER);
  });

  beforeEach(async () => {
    await repo.clearForNode(NODE);
    await repo.clearForNode(OTHER);
  });

  it("reads empty for a node with no rules — unrestricted, not denied", async () => {
    expect(await repo.listForNode(NODE)).toEqual([]);
  });

  it("stores a normalized set and reads it back sorted", async () => {
    const stored = await repo.replaceForNode(NODE, ["/srv/work/", "/home/theo"]);
    expect(stored).toEqual(["/home/theo", "/srv/work"]);
    expect(await repo.listForNode(NODE)).toEqual(["/home/theo", "/srv/work"]);
  });

  it("normalizes on write: invalid dropped, nesting collapsed, dupes removed", async () => {
    const stored = await repo.replaceForNode(NODE, [
      "/home/theo",
      "/home/theo/projects", // covered by the entry above
      "/home/theo/", // duplicate once normalized
      "relative/path", // not absolute
      "/bad/../escape", // carries `..`
    ]);
    expect(stored).toEqual(["/home/theo"]);
    expect(await repo.listForNode(NODE)).toEqual(["/home/theo"]);
  });

  it("replaces the whole set, leaving nothing stale from a larger previous one", async () => {
    await repo.replaceForNode(NODE, ["/a", "/b", "/c"]);
    await repo.replaceForNode(NODE, ["/b"]);
    expect(await repo.listForNode(NODE)).toEqual(["/b"]);
  });

  it("an empty replacement clears the rules, returning the node to unrestricted", async () => {
    await repo.replaceForNode(NODE, ["/a"]);
    expect(await repo.replaceForNode(NODE, [])).toEqual([]);
    expect(await repo.listForNode(NODE)).toEqual([]);
  });

  it("keeps nodes independent", async () => {
    await repo.replaceForNode(NODE, ["/a"]);
    await repo.replaceForNode(OTHER, ["/b"]);
    expect(await repo.listForNode(NODE)).toEqual(["/a"]);
    expect(await repo.listForNode(OTHER)).toEqual(["/b"]);
  });

  it("batches reads for several nodes, defaulting the absent to empty", async () => {
    await repo.replaceForNode(NODE, ["/a"]);
    const map = await repo.listForNodes([NODE, OTHER, "never-seen"]);
    expect(map.get(NODE)).toEqual(["/a"]);
    expect(map.get(OTHER)).toEqual([]);
    expect(map.get("never-seen")).toEqual([]);
  });

  it("cascade-deletes with its node", async () => {
    const doomed = `n-doomed-${crypto.randomUUID()}`;
    await seedNode(doomed);
    await repo.replaceForNode(doomed, ["/a"]);
    await db.deleteFrom("nodes").where("id", "=", doomed).execute();
    expect(await repo.listForNode(doomed)).toEqual([]);
  });
});
