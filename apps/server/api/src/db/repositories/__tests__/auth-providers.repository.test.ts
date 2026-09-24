import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";

const repo = new AuthProvidersRepository(db);

beforeAll(async () => {
  await runMigrations();
});

describe("AuthProvidersRepository", () => {
  test("create → getById round-trips and update stamps the patch", async () => {
    const id = `test-repo-${crypto.randomUUID().slice(0, 8)}`;
    await repo.create({
      id,
      kind: "oidc",
      name: "Test",
      issuer: "https://x.example",
      clientId: "cid",
      clientSecret: "s",
    });
    const row = await repo.getById(id);
    expect(row?.issuer).toBe("https://x.example");
    expect(row?.registrationEnabled).toBeNull();
    await repo.update(id, { registrationEnabled: 0, requireApproval: 1 });
    const after = await repo.getById(id);
    expect(after?.registrationEnabled).toBe(0);
    expect(after?.requireApproval).toBe(1);
    expect(await repo.remove(id)).toBe(true);
    expect(await repo.getById(id)).toBeUndefined();
  });
  test("listAll is ordered by position, and the email row survives", async () => {
    const rows = await repo.listAll();
    expect(rows.some((r) => r.id === "email")).toBe(true);
    const positions = rows.map((r) => r.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
  test("openSignInDoorCount counts enabled+signInEnabled rows only", async () => {
    const before = await repo.openSignInDoorCount();
    const id = `test-door-${crypto.randomUUID().slice(0, 8)}`;
    await repo.create({ id, kind: "oidc", name: "Door", signInEnabled: 1, enabled: 1 });
    expect(await repo.openSignInDoorCount()).toBe(before + 1);
    await repo.update(id, { signInEnabled: 0 });
    expect(await repo.openSignInDoorCount()).toBe(before);
    await repo.remove(id);
  });
});
