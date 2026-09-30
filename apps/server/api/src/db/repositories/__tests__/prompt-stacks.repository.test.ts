import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { PromptStacksRepository, StackMemberReferenceGone } from "@/db/repositories/prompt-stacks.repository.js";
import { PromptsRepository } from "@/db/repositories/prompts.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";

let seq = 0;
// File-salted ids: every test file in one `bun test` invocation shares a
// process and a DB (the prompts twin explains the recipe).
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

describe("PromptStacksRepository", () => {
  const stacks = new PromptStacksRepository(db);
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

  async function mkStack(userId: string, label = "S") {
    return stacks.create({ id: unique("s"), userId, label });
  }

  // Members ride the save method now (the one the route uses); the label
  // patch is carried at the stack's real label so the row reads unchanged.
  async function replace(
    stackId: string,
    items: Parameters<PromptStacksRepository["updateWithItems"]>[2],
    preserve: Parameters<PromptStacksRepository["updateWithItems"]>[3] = [],
  ) {
    const row = await stacks.findById(stackId);
    const saved = await stacks.updateWithItems(
      stackId,
      { label: row?.label ?? "S", shared: row?.shared ?? 0 },
      items,
      preserve,
    );
    return saved.items;
  }

  beforeAll(async () => {
    await setupAuthTables();
    owner = await mkUser("Stack Owner");
    stranger = await mkUser("Stack Stranger");
  });

  afterAll(async () => {
    for (const email of emails) await deleteUserByEmailOrId(email);
  });

  it("create round-trips through findById with defaults mirrored", async () => {
    const row = await mkStack(owner, "Kickoff set");
    expect(row.shared).toBe(0);
    expect(row.updatedAt).toBe(row.createdAt);
    const found = await stacks.findById(row.id);
    expect(found?.label).toBe("Kickoff set");
    await stacks.delete(row.id);
    expect(await stacks.findById(row.id)).toBeUndefined();
  });

  it("createWithItems mints the stack AND its ordered members in one call", async () => {
    const p = await prompts.create({ id: unique("p"), userId: owner, description: "P", body: "ref" });
    const { stack, items } = await stacks.createWithItems(
      { id: unique("s"), userId: owner, label: "Born with members" },
      [
        { promptId: p.id, body: null, description: null },
        { promptId: null, body: "inline", description: "Note" },
      ],
    );
    expect(stack.label).toBe("Born with members");
    expect(items.map((i) => i.ordinal)).toEqual([0, 1]);
    expect(items.map((i) => i.promptId)).toEqual([p.id, null]);
    expect(items.map((i) => i.body)).toEqual([null, "inline"]);
    expect(items[1]?.description).toBe("Note");
    // The row read back is the same set: the create and its members landed together.
    const read = await stacks.listItems(stack.id);
    expect(read.map((i) => i.id)).toEqual(items.map((i) => i.id));
    await stacks.delete(stack.id);
    await prompts.delete(p.id);
  });

  it("createWithItems rejects a deleted reference and commits NOTHING", async () => {
    // The race the route cannot close by checking first: the prompt row dies
    // between the visibility read and this transaction. The in-transaction
    // existence check turns it into the typed error, and the stack row never
    // opens - no strand, and no raw FK 500 for the global handler to swallow.
    const id = unique("s");
    await expect(
      stacks.createWithItems({ id, userId: owner, label: "Racy" }, [
        { promptId: unique("p-gone"), body: null, description: null },
      ]),
    ).rejects.toBeInstanceOf(StackMemberReferenceGone);
    expect(await stacks.findById(id)).toBeUndefined();
  });

  it("updateWithItems rejects a preserved row whose prompt died in the window, committing nothing", async () => {
    const s = await mkStack(owner, "Race save");
    const p = await prompts.create({ id: unique("p"), userId: owner, description: "Doomed", body: "d" });
    await replace(s.id, [
      { promptId: null, body: "visible A", description: null },
      { promptId: p.id, body: null, description: null },
    ]);
    // The caller's snapshot (taken before the delete) still names B's row; the
    // delete already cascaded it out of the DB. A save preserving that stale
    // row must fail as the typed error, not the FK - and not half-apply.
    const snapshot = await stacks.listItems(s.id);
    const staleB = snapshot.find((i) => i.promptId === p.id);
    if (!staleB) throw new Error("seed row missing");
    await prompts.delete(p.id);
    await expect(
      stacks.updateWithItems(
        s.id,
        { label: "Should not land", shared: 0 },
        [{ promptId: null, body: "new head", description: null }],
        [staleB],
      ),
    ).rejects.toBeInstanceOf(StackMemberReferenceGone);
    // The one surviving member is untouched and the row patch did not ride
    // along on the failed save: reference check first, then nothing else ran.
    expect((await stacks.listItems(s.id)).map((i) => i.body)).toEqual(["visible A"]);
    expect((await stacks.findById(s.id))?.label).toBe("Race save");
    await stacks.delete(s.id);
  });

  it("listOwn is owner-scoped and newest-updated first", async () => {
    const a = await mkStack(owner, "A");
    const older = await mkStack(owner, "Older");
    const theirs = await mkStack(stranger, "Theirs");
    await new Promise((r) => setTimeout(r, 2));
    await stacks.update(a.id, { label: "A2" });
    const own = await stacks.listOwn(owner);
    expect(own.map((s) => s.id)).toEqual([a.id, older.id]);
    for (const s of [a, older, theirs]) await stacks.delete(s.id);
  });

  it("listShared returns only other owners' shared stacks", async () => {
    const foreignShared = await stacks.create({ id: unique("s"), userId: stranger, label: "FS", shared: 1 });
    const foreignPrivate = await mkStack(stranger, "FP");
    const ownShared = await stacks.create({ id: unique("s"), userId: owner, label: "OS", shared: 1 });
    const seen = await stacks.listShared(owner);
    expect(seen.map((s) => s.id)).toContain(foreignShared.id);
    expect(seen.map((s) => s.id)).not.toContain(foreignPrivate.id);
    expect(seen.map((s) => s.id)).not.toContain(ownShared.id); // own never rides the shared list
    for (const s of [foreignShared, foreignPrivate, ownShared]) await stacks.delete(s.id);
  });

  it("a save stores the full ordered set: refs, inline rows, ordinals by index", async () => {
    const s = await mkStack(owner);
    const p1 = await prompts.create({ id: unique("p"), userId: owner, description: "P1", body: "one" });
    const p2 = await prompts.create({ id: unique("p"), userId: owner, description: "P2", body: "two" });
    const items = await replace(s.id, [
      { promptId: p1.id, body: null, description: null },
      { promptId: null, body: "my own text", description: "Note" },
      { promptId: p2.id, body: null, description: null },
    ]);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items.map((i) => i.promptId)).toEqual([p1.id, null, p2.id]);
    expect(items[1]?.body).toBe("my own text");
    // A full replace rewrites order: swap and the old rows are gone, not merged
    // (the inline row from the first save is NOT still here).
    const swapped = await replace(s.id, [
      { promptId: p2.id, body: null, description: null },
      { promptId: p1.id, body: null, description: null },
    ]);
    expect(swapped.map((i) => i.promptId)).toEqual([p2.id, p1.id]);
    expect(swapped).toHaveLength(2);
    await stacks.delete(s.id);
    await prompts.delete(p1.id);
    await prompts.delete(p2.id);
  });

  it("a save carries preserved rows through with their id, landed behind the new set", async () => {
    const s = await mkStack(owner);
    await replace(s.id, [
      { promptId: null, body: "to hide", description: null },
      { promptId: null, body: "to replace", description: null },
    ]);
    // The caller's read dropped "to hide" (invisible prompt); its row is what
    // a full replace must carry through, keyed by id.
    const hidden = (await stacks.listItems(s.id)).filter((i) => i.body === "to hide");
    expect(hidden).toHaveLength(1);
    const next = await replace(s.id, [{ promptId: null, body: "new head", description: null }], hidden);
    // The new row is 0; the preserved one follows, SAME id, content intact.
    expect(next.map((i) => i.ordinal)).toEqual([0, 1]);
    expect(next[1]?.id).toBe(hidden[0]?.id);
    expect(next[1]?.body).toBe("to hide");
    expect(next[0]?.body).toBe("new head");
    await stacks.delete(s.id);
  });

  it("an empty member list in a save empties the stack", async () => {
    const s = await mkStack(owner);
    await replace(s.id, [{ promptId: null, body: "x", description: null }]);
    const after = await replace(s.id, []);
    expect(after).toHaveLength(0);
    expect(await stacks.listItems(s.id)).toHaveLength(0);
    await stacks.delete(s.id);
  });

  it("listItemsForStacks is batched and ordinal-ordered per stack", async () => {
    const a = await mkStack(owner);
    const b = await mkStack(owner);
    await replace(a.id, [
      { promptId: null, body: "a1", description: null },
      { promptId: null, body: "a2", description: null },
    ]);
    await replace(b.id, [{ promptId: null, body: "b1", description: null }]);
    const items = await stacks.listItemsForStacks([a.id, b.id, unique("nope")]);
    expect(items.map((i) => `${i.stackId}:${i.body}`)).toEqual([`${a.id}:a1`, `${a.id}:a2`, `${b.id}:b1`]);
    expect(await stacks.listItemsForStacks([])).toEqual([]);
    await stacks.delete(a.id);
    await stacks.delete(b.id);
  });

  it("deleting a PROMPT cascades its member rows away and leaves the stack empty", async () => {
    const s = await mkStack(owner);
    const p = await prompts.create({ id: unique("p"), userId: owner, description: "Doomed", body: "d" });
    await replace(s.id, [
      { promptId: p.id, body: null, description: null },
      { promptId: null, body: "inline stays", description: null },
    ]);
    await prompts.delete(p.id);
    const items = await stacks.listItems(s.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.body).toBe("inline stays"); // only the reference row followed the prompt
    expect(await stacks.findById(s.id)).toBeDefined(); // the stack itself survives
    await stacks.delete(s.id);
  });

  it("deleting a STACK cascades all its member rows", async () => {
    const s = await mkStack(owner);
    await replace(s.id, [{ promptId: null, body: "gone with it", description: null }]);
    await stacks.delete(s.id);
    expect(await stacks.listItems(s.id)).toHaveLength(0);
  });

  it("update re-stamps updatedAt in ISO form; delete is a no-op on an unknown id", async () => {
    const s = await mkStack(owner);
    await new Promise((r) => setTimeout(r, 2));
    const updated = await stacks.update(s.id, { label: "Renamed", shared: 1 });
    expect(updated?.label).toBe("Renamed");
    expect(updated?.shared).toBe(1);
    expect(updated?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((updated?.updatedAt ?? "") >= s.createdAt).toBe(true);
    await stacks.delete(s.id);
    await stacks.delete(unique("s")); // must not throw
  });
});
