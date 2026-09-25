import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";

/**
 * The transactional last-door guard (Task 8 review, Important 1). A
 * check-then-write split across statements lets two concurrent closes both
 * pass on the same snapshot and land the instance at zero open doors; the
 * repository's `patchGuardingLastDoor` / `deleteGuardingLastDoor` write the
 * count-check and the mutation as ONE transaction, the `setRole` precedent —
 * whose note that a plain `db.transaction()` suffices here (one shared
 * synchronous `bun:sqlite` connection; the awaits never yield mid-unit) is
 * exercised the same way: fire the closes at once and assert the invariant
 * survives, nothing throws.
 */
const repo = new AuthProvidersRepository(db);
const doorA = `apv-race-a-${crypto.randomUUID().slice(0, 8)}`;
const doorB = `apv-race-b-${crypto.randomUUID().slice(0, 8)}`;

describe("transactional last-door guard", () => {
  /** Foreign open doors force-closed for the scenario; restored after. */
  let restored: { id: string; enabled: number }[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    restored = [];
    for (const row of await repo.listAll()) {
      restored.push({ id: row.id, enabled: row.enabled });
      if (row.enabled === 1) await repo.update(row.id, { enabled: 0 });
    }
    for (const id of [doorA, doorB]) {
      await repo.create({ id, kind: "oidc", name: id, enabled: 1, signInEnabled: 1 });
    }
    expect(await repo.openSignInDoorCount()).toBe(2);
  });

  afterAll(async () => {
    await repo.remove(doorA);
    await repo.remove(doorB);
    for (const { id, enabled } of restored) await repo.update(id, { enabled });
  });

  it("two concurrent closes on the last TWO doors leave exactly one open", async () => {
    const closeA = repo.patchGuardingLastDoor(doorA, { enabled: 0, signInEnabled: 0 }, false);
    const closeB = repo.patchGuardingLastDoor(doorB, { enabled: 0, signInEnabled: 0 }, false);
    const [a, b] = await Promise.all([closeA, closeB]);
    // One commits, the other is refused — never both, never a throw.
    expect([a, b].filter((r) => r === "ok")).toHaveLength(1);
    expect([a, b].filter((r) => r === "last_door")).toHaveLength(1);
    expect(await repo.openSignInDoorCount()).toBe(1);
  });

  it("a concurrent close + delete of the same two doors holds the same line", async () => {
    // Reset both open, then race a PATCH-close of A against a DELETE of B.
    await repo.update(doorA, { enabled: 1, signInEnabled: 1 });
    await repo.update(doorB, { enabled: 1, signInEnabled: 1 });
    expect(await repo.openSignInDoorCount()).toBe(2);
    const [patch, del] = await Promise.all([
      repo.patchGuardingLastDoor(doorA, { enabled: 0 }, false),
      repo.deleteGuardingLastDoor(doorB),
    ]);
    expect([patch, del].filter((r) => r === "ok")).toHaveLength(1);
    expect([patch, del].filter((r) => r === "last_door")).toHaveLength(1);
    expect(await repo.openSignInDoorCount()).toBe(1);
  });

  it("patching a CLOSED door as closed, or opening one, never trips the guard", async () => {
    // The races above leave one of the two doors deleted or closed, so this
    // test states its own fixture: A present and CLOSED, B the last open one.
    if (!(await repo.getById(doorA))) {
      await repo.create({ id: doorA, kind: "oidc", name: doorA, enabled: 0, signInEnabled: 0 });
    } else {
      await repo.update(doorA, { enabled: 0, signInEnabled: 0 });
    }
    if (!(await repo.getById(doorB))) {
      await repo.create({ id: doorB, kind: "oidc", name: doorB, enabled: 1, signInEnabled: 1 });
    } else {
      await repo.update(doorB, { enabled: 1, signInEnabled: 1 });
    }
    expect(await repo.openSignInDoorCount()).toBe(1);
    // A rename on the closed door does not touch the count: ok.
    expect(await repo.patchGuardingLastDoor(doorA, { name: "rename-only" }, false)).toBe("ok");
    // Closing the last open door is still refused.
    expect(await repo.patchGuardingLastDoor(doorB, { enabled: 0 }, false)).toBe("last_door");
    // Opening a door can never strand the instance.
    expect(await repo.patchGuardingLastDoor(doorA, { enabled: 1, signInEnabled: 1 }, true)).toBe("ok");
  });

  it("unknown ids answer not_found from inside the transaction", async () => {
    expect(await repo.patchGuardingLastDoor("apv-nope", { name: "x" }, false)).toBe("not_found");
    expect(await repo.deleteGuardingLastDoor("apv-nope")).toBe("not_found");
  });
});
