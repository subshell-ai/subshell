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

  it("mints an nsk_ key the row itself carries; consume is single-use", async () => {
    const row = await repo.create(unique("u"), 60_000);
    // The mint shape the install script re-checks and the desktop app validates.
    expect(row.key).toMatch(/^nsk_[A-Za-z0-9_-]{32}$/);
    // The stored form IS the key: since 0033 the Setup keys page renders this
    // column, so there is no "never persisted" half to assert any more. What
    // stays true is that `create` names nothing — no label, no node name.
    const stored = await repo.findById(row.id);
    expect(stored?.key).toBe(row.key);
    expect(stored).not.toHaveProperty("label");
    expect(stored).not.toHaveProperty("keyHash");
    const consumed = await repo.consume(row.key, "n1");
    expect(consumed?.id).toBe(row.id);
    // Post-flip state: the winner's copy already carries its own spend.
    expect(consumed?.usedAt).not.toBeNull();
    expect(consumed?.consumedNodeId).toBe("n1");
    expect(await repo.consume(row.key, "n2")).toBeNull();
    const after = await repo.findById(row.id);
    expect(after?.usedAt).not.toBeNull();
    expect(after?.consumedNodeId).toBe("n1");
  });

  it("expired and unknown-key consumption return null", async () => {
    const expired = await repo.create(unique("u"), -1000); // already expired
    expect(await repo.consume(expired.key, "n1")).toBeNull();
    expect(await repo.consume("nsk_nonexistent", "n1")).toBeNull();
  });

  it("two concurrent consumes of one key: exactly one wins", async () => {
    const { key } = await repo.create(unique("u"), 60_000);
    const results = await Promise.all([repo.consume(key, "node-a"), repo.consume(key, "node-b")]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("peekValid: fresh true, wrong/used/expired false — and never consumes", async () => {
    const { key } = await repo.create(unique("u"), 60_000);
    expect(await repo.peekValid(key)).toBe(true);
    expect(await repo.peekValid("nsk_wrong")).toBe(false);
    // peek is consumption-free: repeatable, and the key still redeems afterwards.
    expect(await repo.peekValid(key)).toBe(true);
    await repo.consume(key, "n1");
    expect(await repo.peekValid(key)).toBe(false);
    const stale = await repo.create(unique("u"), -1000);
    expect(await repo.peekValid(stale.key)).toBe(false);
  });

  it("peekByKey: read-only state probe — absent/valid/consumed/expired (ledger 17a)", async () => {
    // Unknown key: undefined, never a throw.
    expect(await repo.peekByKey("nsk_never_minted")).toBeUndefined();
    // Fresh key: unused, expires in the future.
    const { key } = await repo.create(unique("u"), 60_000);
    const fresh = await repo.peekByKey(key);
    expect(fresh?.usedAt).toBeNull();
    expect(Date.parse(fresh?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    // Read-only: repeatable, and the key still redeems afterwards.
    expect(await repo.peekByKey(key)).toEqual(fresh);
    await repo.consume(key, "n1");
    expect((await repo.peekByKey(key))?.usedAt).not.toBeNull();
    // Expired key: still reported (with its past expiresAt) — the ROUTE decides the code.
    const stale = await repo.create(unique("u"), -1000);
    const past = await repo.peekByKey(stale.key);
    expect(past?.usedAt).toBeNull();
    expect(Date.parse(past?.expiresAt ?? "")).toBeLessThanOrEqual(Date.now());
  });

  it("listByUser scoped to owner; deleteById only by owner", async () => {
    const owner = unique("u");
    const row = await repo.create(owner);
    expect(await repo.listByUser(owner)).toHaveLength(1);
    expect(await repo.listByUser(unique("u"))).toHaveLength(0);
    expect(await repo.deleteById(row.id, "someone-else")).toBe(0);
    expect(await repo.deleteById(row.id, owner)).toBeGreaterThan(0);
  });
});
