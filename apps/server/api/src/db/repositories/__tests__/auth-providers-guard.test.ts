import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";

/**
 * The transactional last-provider guard (Task 8 review, Important 1). A
 * check-then-write split across statements lets two concurrent closes both
 * pass on the same snapshot and land the instance at zero open providers; the
 * repository's `patchGuardingLastProvider` / `deleteGuardingLastProvider` write the
 * count-check and the mutation as ONE transaction, the `setRole` precedent —
 * whose note that a plain `db.transaction()` suffices here (one shared
 * synchronous `bun:sqlite` connection; the awaits never yield mid-unit) is
 * exercised the same way: fire the closes at once and assert the invariant
 * survives, nothing throws.
 */
const repo = new AuthProvidersRepository(db);
const providerA = `apv-race-a-${crypto.randomUUID().slice(0, 8)}`;
const providerB = `apv-race-b-${crypto.randomUUID().slice(0, 8)}`;

describe("transactional last-provider guard", () => {
  /** Foreign open providers force-closed for the scenario; restored after. */
  let restored: { id: string; enabled: number }[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    restored = [];
    for (const row of await repo.listAll()) {
      restored.push({ id: row.id, enabled: row.enabled });
      if (row.enabled === 1) await repo.update(row.id, { enabled: 0 });
    }
    for (const id of [providerA, providerB]) {
      await repo.create({ id, kind: "oidc", name: id, enabled: 1, signInEnabled: 1 });
    }
    expect(await repo.openSignInProviderCount()).toBe(2);
  });

  afterAll(async () => {
    await repo.remove(providerA);
    await repo.remove(providerB);
    for (const { id, enabled } of restored) await repo.update(id, { enabled });
  });

  it("two concurrent closes on the last TWO providers leave exactly one open", async () => {
    const closeA = repo.patchGuardingLastProvider(providerA, { enabled: 0, signInEnabled: 0 }, false);
    const closeB = repo.patchGuardingLastProvider(providerB, { enabled: 0, signInEnabled: 0 }, false);
    const [a, b] = await Promise.all([closeA, closeB]);
    // One commits, the other is refused — never both, never a throw.
    expect([a, b].filter((r) => r === "ok")).toHaveLength(1);
    expect([a, b].filter((r) => r === "last_provider")).toHaveLength(1);
    expect(await repo.openSignInProviderCount()).toBe(1);
  });

  it("a concurrent close + delete of the same two providers holds the same line", async () => {
    // Reset both open, then race a PATCH-close of A against a DELETE of B.
    await repo.update(providerA, { enabled: 1, signInEnabled: 1 });
    await repo.update(providerB, { enabled: 1, signInEnabled: 1 });
    expect(await repo.openSignInProviderCount()).toBe(2);
    const [patch, del] = await Promise.all([
      repo.patchGuardingLastProvider(providerA, { enabled: 0 }, false),
      repo.deleteGuardingLastProvider(providerB),
    ]);
    expect([patch, del].filter((r) => r === "ok")).toHaveLength(1);
    expect([patch, del].filter((r) => r === "last_provider")).toHaveLength(1);
    expect(await repo.openSignInProviderCount()).toBe(1);
  });

  it("patching a CLOSED provider as closed, or opening one, never trips the guard", async () => {
    // The races above leave one of the two providers deleted or closed, so this
    // test states its own fixture: A present and CLOSED, B the last open one.
    if (!(await repo.getById(providerA))) {
      await repo.create({ id: providerA, kind: "oidc", name: providerA, enabled: 0, signInEnabled: 0 });
    } else {
      await repo.update(providerA, { enabled: 0, signInEnabled: 0 });
    }
    if (!(await repo.getById(providerB))) {
      await repo.create({ id: providerB, kind: "oidc", name: providerB, enabled: 1, signInEnabled: 1 });
    } else {
      await repo.update(providerB, { enabled: 1, signInEnabled: 1 });
    }
    expect(await repo.openSignInProviderCount()).toBe(1);
    // A rename on the closed provider does not touch the count: ok.
    expect(await repo.patchGuardingLastProvider(providerA, { name: "rename-only" }, false)).toBe("ok");
    // Closing the last open provider is still refused.
    expect(await repo.patchGuardingLastProvider(providerB, { enabled: 0 }, false)).toBe("last_provider");
    // Opening a provider can never strand the instance.
    expect(await repo.patchGuardingLastProvider(providerA, { enabled: 1, signInEnabled: 1 }, true)).toBe("ok");
  });

  it("unknown ids answer not_found from inside the transaction", async () => {
    expect(await repo.patchGuardingLastProvider("apv-nope", { name: "x" }, false)).toBe("not_found");
    expect(await repo.deleteGuardingLastProvider("apv-nope")).toBe("not_found");
  });
});
