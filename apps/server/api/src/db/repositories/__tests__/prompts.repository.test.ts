import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { PromptsRepository } from "@/db/repositories/prompts.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";

let seq = 0;
// Salt per file: every test file in one `bun test` invocation shares one
// process, so ids must be file-salted (the node-shares twin explains why).
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

describe("PromptsRepository", () => {
  const prompts = new PromptsRepository(db);
  let owner: string;
  let stranger: string;
  const emails: string[] = [];

  async function mkUser(label: string): Promise<string> {
    const email = `${unique("u")}@subshell.local`;
    emails.push(email);
    return new UsersRepository(db).createUser({
      email,
      name: label,
      passwordHash: await hashPassword("repo-test-pass-1"),
      role: "user",
    });
  }

  beforeAll(async () => {
    // The prompts FK points at better-auth's `user`, so the auth schema has
    // to exist (the route-suite recipe), not just the app tables.
    await setupAuthTables();
    owner = await mkUser("Owner O");
    stranger = await mkUser("Stranger S");
  });

  afterAll(async () => {
    for (const email of emails) await deleteUserByEmailOrId(email);
  });

  it("create round-trips through findById with defaults mirrored", async () => {
    const row = await prompts.create({
      id: unique("p"),
      userId: owner,
      description: "Kickoff",
      body: "Start the task",
    });
    expect(row.shared).toBe(0);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(row.updatedAt).toBe(row.createdAt);
    const found = await prompts.findById(row.id);
    expect(found?.body).toBe("Start the task");
    await prompts.delete(row.id);
    expect(await prompts.findById(row.id)).toBeUndefined();
  });

  it("listOwn is owner-scoped and newest-updated first", async () => {
    const a = await prompts.create({ id: unique("p"), userId: owner, description: "A", body: "a" });
    const older = await prompts.create({ id: unique("p"), userId: owner, description: "Older", body: "o" });
    const theirs = await prompts.create({ id: unique("p"), userId: stranger, description: "B", body: "b" });
    // Touch A so it sorts above the other OWN row; the foreign row never appears.
    await new Promise((r) => setTimeout(r, 2));
    await prompts.update(a.id, { body: "a2" });
    const own = await prompts.listOwn(owner);
    expect(own.map((p) => p.id)).toEqual([a.id, older.id]);
    await prompts.delete(a.id);
    await prompts.delete(older.id);
    await prompts.delete(theirs.id);
  });

  it("listShared returns only other owners' shared rows", async () => {
    const mineShared = await prompts.create({
      id: unique("p"),
      userId: stranger,
      description: "S",
      body: "s",
      shared: 1,
    });
    const minePrivate = await prompts.create({ id: unique("p"), userId: stranger, description: "P", body: "p" });
    const ownShared = await prompts.create({
      id: unique("p"),
      userId: owner,
      description: "OS",
      body: "os",
      shared: 1,
    });
    const seen = await prompts.listShared(owner);
    expect(seen.map((p) => p.id)).toContain(mineShared.id);
    expect(seen.map((p) => p.id)).not.toContain(minePrivate.id);
    expect(seen.map((p) => p.id)).not.toContain(ownShared.id); // own never rides the shared list
    for (const p of [mineShared, minePrivate, ownShared]) await prompts.delete(p.id);
  });

  it("update applies patches, flips shared, and re-stamps updatedAt in ISO form", async () => {
    const row = await prompts.create({ id: unique("p"), userId: owner, description: "Old", body: "old" });
    await new Promise((r) => setTimeout(r, 2));
    const updated = await prompts.update(row.id, { description: "New", shared: 1 });
    expect(updated?.description).toBe("New");
    expect(updated?.shared).toBe(1);
    expect(updated?.body).toBe("old");
    expect(updated?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((updated?.updatedAt ?? "") >= row.updatedAt).toBe(true);
    await prompts.delete(row.id);
  });

  it("delete is a no-op on an unknown id", async () => {
    await prompts.delete(unique("p")); // must not throw
  });
});
