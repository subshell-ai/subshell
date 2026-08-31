import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";

let seq = 0;
// Salt per file: every test file in one `bun test` invocation shares one process
// (same pid) and its seq restarts at 0, so the bare pid+seq id would collide
// across files (e.g. the nodes owner+name unique index).
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

beforeAll(async () => {
  await runMigrations();
});

describe("NodeSetupKeysRepository", () => {
  const repo = new NodeSetupKeysRepository(db);

  it("plaintext keys never persist; consume is single-use", async () => {
    const { row, plaintext } = await repo.create("lab", unique("u"), 60_000);
    expect(plaintext.startsWith("nsk_")).toBe(true);
    const stored = await repo.findById(row.id);
    expect(stored?.keyHash).not.toContain(plaintext);
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    const consumed = await repo.consume(plaintext, "n1");
    expect(consumed?.id).toBe(row.id);
    expect(await repo.consume(plaintext, "n2")).toBeNull();
    const after = await repo.findById(row.id);
    expect(after?.usedAt).not.toBeNull();
    expect(after?.consumedNodeId).toBe("n1");
  });

  it("expired and wrong-hash consumption return null", async () => {
    const { plaintext } = await repo.create("old", unique("u"), -1000); // already expired
    expect(await repo.consume(plaintext, "n1")).toBeNull();
    expect(await repo.consume("nsk_nonexistent", "n1")).toBeNull();
  });

  it("two concurrent consumes of one key: exactly one wins", async () => {
    const { plaintext } = await repo.create("race", unique("u"), 60_000);
    const results = await Promise.all([repo.consume(plaintext, "node-a"), repo.consume(plaintext, "node-b")]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("listByUser scoped to owner; deleteById only by owner", async () => {
    const owner = unique("u");
    const { row } = await repo.create("lab", owner);
    expect(await repo.listByUser(owner)).toHaveLength(1);
    expect(await repo.listByUser(unique("u"))).toHaveLength(0);
    expect(await repo.deleteById(row.id, "someone-else")).toBe(0);
    expect(await repo.deleteById(row.id, owner)).toBeGreaterThan(0);
  });
});
