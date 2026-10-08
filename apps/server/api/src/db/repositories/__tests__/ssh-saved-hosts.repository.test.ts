import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { SshSavedHostsRepository } from "@/db/repositories/ssh-saved-hosts.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * The per-owner SSH destination ledger (spec 2026-10-07 §7). The properties
 * this suite exists to pin:
 *
 * - the key is (owner, canonical destination): `touch` REFRESHES recency on
 *   an existing row rather than adding a second one, and two owners may hold
 *   the same destination as two rows;
 * - recency (`last_connect_at`) rides EVERY launch whether or not the row was
 *   ever saved; `saved_at` is only what the human gave (null = recency-only);
 * - the list reads never carry another owner's rows, and `remove` refuses a
 *   foreign id exactly like an absent one (the ownership axis, docs/security.md §3).
 */

const repo = new SshSavedHostsRepository(db);
const emails: string[] = [];
const inserted: string[] = [];
let ownerA = "";
let ownerB = "";

const at = (iso: string) => ({ at: iso });

async function mkUser(tag: string): Promise<string> {
  const email = `sh-repo-${tag}-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("sh-repo-1"),
    role: "user",
  });
}

beforeAll(async () => {
  await setupAuthTables();
  ownerA = await mkUser("a");
  ownerB = await mkUser("b");
});

afterAll(async () => {
  for (const id of inserted) await db.deleteFrom("sshSavedHosts").where("id", "=", id).execute();
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

describe("ssh-saved-hosts repository", () => {
  it("touch inserts a recency-only row and REFRESHES it on the same key (one row, moved node + stamp)", async () => {
    const destination = "example.test:22";
    await repo.touch({
      ownerUserId: ownerA,
      destination,
      nodeId: "node-1",
      alias: "work",
      ...at("2026-10-07T10:00:00.000Z"),
    });
    const row = await db
      .selectFrom("sshSavedHosts")
      .selectAll()
      .where("destination", "=", destination)
      .executeTakeFirstOrThrow();
    inserted.push(row.id);
    expect(row.ownerUserId).toBe(ownerA);
    expect(row.nodeId).toBe("node-1");
    expect(row.alias).toBe("work");
    expect(row.savedAt).toBeNull();
    expect(row.lastConnectAt).toBe("2026-10-07T10:00:00.000Z");

    await repo.touch({ ownerUserId: ownerA, destination, nodeId: "node-2", ...at("2026-10-07T12:00:00.000Z") });
    const rows = await db.selectFrom("sshSavedHosts").selectAll().where("destination", "=", destination).execute();
    expect(rows).toHaveLength(1); // refreshed, not doubled
    expect(rows[0].id).toBe(row.id); // the SAME row
    expect(rows[0].nodeId).toBe("node-2"); // the machine of the most recent launch
    expect(rows[0].lastConnectAt).toBe("2026-10-07T12:00:00.000Z");
    // An absent alias does NOT wipe the standing one (the display token outlives a bare-host launch).
    expect(rows[0].alias).toBe("work");
  });

  it("two owners may hold the same canonical destination as two rows", async () => {
    const destination = "shared.test:2222";
    await repo.touch({ ownerUserId: ownerA, destination, nodeId: "node-1", ...at("2026-10-07T10:00:00.000Z") });
    await repo.touch({ ownerUserId: ownerB, destination, nodeId: "node-1", ...at("2026-10-07T10:00:00.000Z") });
    const rows = await db.selectFrom("sshSavedHosts").selectAll().where("destination", "=", destination).execute();
    expect(rows).toHaveLength(2);
    inserted.push(...rows.map((r) => r.id));
  });

  it("markSaved stamps saved_at and returns the row (upsert on an existing recency-only key)", async () => {
    const destination = "save.test:22";
    await repo.touch({ ownerUserId: ownerA, destination, nodeId: "node-1", ...at("2026-10-07T09:00:00.000Z") });
    const first = await db
      .selectFrom("sshSavedHosts")
      .select("id")
      .where("destination", "=", destination)
      .where("ownerUserId", "=", ownerA)
      .executeTakeFirstOrThrow();
    inserted.push(first.id);

    const row = await repo.markSaved({
      ownerUserId: ownerA,
      destination,
      nodeId: "node-1",
      alias: "lab",
      ...at("2026-10-07T11:00:00.000Z"),
    });
    expect(row.id).toBe(first.id); // saved the SAME row the launch had touched
    expect(row.savedAt).toBe("2026-10-07T11:00:00.000Z");
    expect(row.alias).toBe("lab");
    expect(row.lastConnectAt).toBe("2026-10-07T11:00:00.000Z");
  });

  it("listSaved reads only saved rows, newest-saved first; listRecent reads everything by recency", async () => {
    // Destinations tagged per case: the earlier cases' rows exist too, and a
    // whole-table ordering assertion would depend on THEIR stamps.
    const tag = crypto.randomUUID().slice(0, 8);
    await repo.markSaved({
      ownerUserId: ownerA,
      destination: `${tag}-old.test:22`,
      nodeId: "n",
      ...at("2026-10-07T08:00:00.000Z"),
    });
    await repo.markSaved({
      ownerUserId: ownerA,
      destination: `${tag}-new.test:22`,
      nodeId: "n",
      ...at("2026-10-07T14:00:00.000Z"),
    });
    await repo.touch({
      ownerUserId: ownerA,
      destination: `${tag}-just.test:22`,
      nodeId: "n",
      ...at("2026-10-07T15:00:00.000Z"),
    });
    const saved = await repo.listSaved(ownerA);
    const recent = await repo.listRecent(ownerA);
    const savedDests = saved.map((r) => r.destination).filter((d) => d.startsWith(tag));
    // Only rows a human gave (savedAt non-null); the recency-only row is absent.
    expect(savedDests).toEqual([`${tag}-new.test:22`, `${tag}-old.test:22`]);
    expect(savedDests).not.toContain(`${tag}-just.test:22`);
    // Recency lists everything, newest connect first; the unsaved launch leads.
    expect(recent[0]?.destination).toBe(`${tag}-just.test:22`);
    const recentDests = recent.map((r) => r.destination);
    expect(recentDests).toContain(`${tag}-old.test:22`);
    inserted.push(...saved.map((r) => r.id), ...recent.map((r) => r.id));
  });

  it("listRecent caps at 20 by default and honors an explicit limit", async () => {
    const tag = `cap-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 25; i++) {
      await repo.touch({
        ownerUserId: ownerA,
        destination: `${tag}-${i}.test:22`,
        nodeId: "n",
        ...at(`2026-10-0${(i % 7) + 1}T00:00:0${i % 10}.000Z`),
      });
    }
    const rows = await db.selectFrom("sshSavedHosts").select("id").where("destination", "like", `${tag}-%`).execute();
    inserted.push(...rows.map((r) => r.id));
    expect(await repo.listRecent(ownerA)).toHaveLength(20);
    expect(await repo.listRecent(ownerA, 5)).toHaveLength(5);
  });

  it("remove deletes the owner's row; a foreign id and an absent id both answer false", async () => {
    const destination = "remove.test:22";
    const row = await repo.markSaved({
      ownerUserId: ownerA,
      destination,
      nodeId: "n",
      ...at("2026-10-07T10:00:00.000Z"),
    });
    expect(await repo.remove(ownerB, row.id)).toBe(false); // foreign: refused like an absent one (no existence oracle)
    expect(await db.selectFrom("sshSavedHosts").select("id").where("id", "=", row.id).executeTakeFirst()).toBeDefined();
    expect(await repo.remove(ownerA, row.id)).toBe(true);
    expect(await repo.remove(ownerA, row.id)).toBe(false); // already gone
    expect(await repo.remove(ownerA, "never-an-id")).toBe(false);
  });
});
