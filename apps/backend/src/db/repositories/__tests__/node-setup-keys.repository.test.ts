import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { hashKey, NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";

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
    // Post-flip state: the winner's copy already carries its own spend.
    expect(consumed?.usedAt).not.toBeNull();
    expect(consumed?.consumedNodeId).toBe("n1");
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

  it("peekValid: fresh true, wrong/used/expired false — and never consumes", async () => {
    const { plaintext } = await repo.create("peek", unique("u"), 60_000);
    expect(await repo.peekValid(plaintext)).toBe(true);
    expect(await repo.peekValid("nsk_wrong")).toBe(false);
    // peek is consumption-free: repeatable, and the key still redeems afterwards.
    expect(await repo.peekValid(plaintext)).toBe(true);
    await repo.consume(plaintext, "n1");
    expect(await repo.peekValid(plaintext)).toBe(false);
    const { plaintext: expired } = await repo.create("stale", unique("u"), -1000);
    expect(await repo.peekValid(expired)).toBe(false);
  });

  it("peekByHash: read-only state probe — absent/valid/consumed/expired (ledger 17a)", async () => {
    // Unknown hash: undefined, never a throw.
    expect(await repo.peekByHash("0".repeat(64))).toBeUndefined();
    // Fresh key: unused, expires in the future.
    const { plaintext } = await repo.create("peekhash", unique("u"), 60_000);
    const h = hashKey(plaintext);
    const fresh = await repo.peekByHash(h);
    expect(fresh?.usedAt).toBeNull();
    expect(Date.parse(fresh?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    // Read-only: repeatable, and the key still redeems afterwards.
    expect(await repo.peekByHash(h)).toEqual(fresh);
    await repo.consume(plaintext, "n1");
    expect((await repo.peekByHash(h))?.usedAt).not.toBeNull();
    // Expired key: still reported (with its past expiresAt) — the ROUTE decides the code.
    const { plaintext: expired } = await repo.create("peekhash-old", unique("u"), -1000);
    const past = await repo.peekByHash(hashKey(expired));
    expect(past?.usedAt).toBeNull();
    expect(Date.parse(past?.expiresAt ?? "")).toBeLessThanOrEqual(Date.now());
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
