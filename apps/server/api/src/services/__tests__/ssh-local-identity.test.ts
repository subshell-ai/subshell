import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { createLocalRelayIdentityProvider } from "../ssh-local-identity.js";

const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "ssh-local-id-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("concurrent first use registers one identity and restart preserves exact public bytes", async () => {
  const dir = await directory();
  let registrations = 0;
  const provider = createLocalRelayIdentityProvider(dir, async () => {
    registrations++;
  });
  const identities = await Promise.all(Array.from({ length: 20 }, () => provider()));
  expect(new Set(identities.map((identity) => identity.publicJwk)).size).toBe(1);
  expect(registrations).toBe(1);
  const restart = createLocalRelayIdentityProvider(dir, async () => {});
  expect(await restart()).toEqual(identities[0]);
});

test("corrupt disk is preserved and remains refused after repeated calls and restart", async () => {
  const dir = await directory();
  await writeFile(join(dir, "identity.json"), "corrupt");
  const provider = createLocalRelayIdentityProvider(dir, async () => {
    throw new Error("must not register");
  });
  await expect(provider()).rejects.toThrow("unreadable");
  await expect(provider()).rejects.toThrow("unreadable");
  await expect(createLocalRelayIdentityProvider(dir, async () => {})()).rejects.toThrow("unreadable");
  expect(await readFile(join(dir, "identity.json"), "utf8")).toBe("corrupt");
});

test("registration mismatch stays refused without regenerating the disk identity", async () => {
  const dir = await directory();
  let registrations = 0;
  const provider = createLocalRelayIdentityProvider(dir, async () => {
    registrations++;
    throw new Error("registered identity differs");
  });
  await expect(provider()).rejects.toThrow("differs");
  const bytes = await readFile(join(dir, "identity.json"), "utf8");
  await expect(provider()).rejects.toThrow("differs");
  expect(registrations).toBe(1);
  expect(await readFile(join(dir, "identity.json"), "utf8")).toBe(bytes);
});

test("database first-registration race cannot replace either public half; an empty signing slot only fills for matching encryption", async () => {
  await ensureMigratedTestDb();
  const repo = new IdentitiesRepository(db);
  const principalId = `node:local-test-${crypto.randomUUID()}`;
  const one = { principalId, publicKey: "encryption-one", signingPublicKey: "signing-one", displayName: null };
  const two = { ...one, publicKey: "encryption-two", signingPublicKey: "signing-two" };
  const outcomes = await Promise.all([repo.registerIfMatching(one), repo.registerIfMatching(two)]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const standing = await repo.findByPrincipal(principalId);
  expect(await repo.registerIfMatching(outcomes[0] ? two : one)).toBe(false);
  expect(await repo.findByPrincipal(principalId)).toEqual(standing);
  await db.updateTable("identities").set({ signingPublicKey: null }).where("principalId", "=", principalId).execute();
  expect(await repo.registerIfMatching(outcomes[0] ? two : one)).toBe(false);
  expect((await repo.findByPrincipal(principalId))?.signingPublicKey).toBeNull();
  expect(await repo.registerIfMatching(outcomes[0] ? one : two)).toBe(true);
  await db.deleteFrom("identities").where("principalId", "=", principalId).execute();
});
