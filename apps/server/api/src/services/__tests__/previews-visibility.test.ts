import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";

/**
 * **The one gate stopping a viewer capturing a pane they may not see.**
 *
 * Screens are PULLED over `/ws/live` (spec 2026-09-19 §4.4): the client names
 * ids and the server answers. Nothing else stands between that request and a
 * `capture-pane` — `handleLiveMessage` truncates the list and injects this
 * method, and every test there passes a stub, so the real
 * `listVisibleTo ∩ ids` filter was exercised nowhere at all.
 *
 * A pane's rendered output is the most sensitive thing this app produces
 * (`docs/security.md`, pane logs), so the assertion is about which rows reach
 * the capture — not merely about what comes back. A filter that let the row
 * through and captured nothing would look identical from the outside, which
 * is why the manager's own method is what is watched.
 *
 * And the answer OMITS what the viewer cannot see rather than refusing it:
 * the same 404-not-403 rule the per-subshell routes follow, so ids stay
 * unprobeable.
 */
const password = "previews-visibility-pass-1";
const ownerEmail = `prev-owner-${crypto.randomUUID()}@subshell.local`;
const strangerEmail = `prev-stranger-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `prev-admin-${crypto.randomUUID()}@subshell.local`;

let ownerId: string;
let strangerId: string;
let adminId: string;
let subshellId: string;

/** Rows the manager was actually asked to capture, across one call. */
function watchCaptures() {
  const seen: string[][] = [];
  const spy = spyOn(SubshellManagerService.prototype, "previewsFor").mockImplementation(async (rows) => {
    seen.push(rows.map((r) => r.id));
    return new Map(rows.map((r) => [r.id, ["screen"]]));
  });
  return { seen, spy };
}

describe("previewsFor captures only what the viewer may see", () => {
  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    const make = async (email: string, role: "user" | "admin") =>
      await users.createUser({ email, name: email, passwordHash: await hashPassword(password), role });
    ownerId = await make(ownerEmail, "user");
    strangerId = await make(strangerEmail, "user");
    adminId = await make(adminEmail, "admin");

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: ownerId,
      presetId: "p",
      harnessId: "claude-code",
      name: "private-session",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
  });

  afterEach(() => {
    spyOn(SubshellManagerService.prototype, "previewsFor").mockRestore();
  });

  afterAll(async () => {
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    for (const email of [ownerEmail, strangerEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  it("captures nothing at all for a viewer the row is invisible to", async () => {
    const { seen, spy } = watchCaptures();
    try {
      const out = await getRequestlessContext().services.subshells.previewsFor(strangerId, [subshellId]);
      // The capture never happened…
      expect(seen).toEqual([[]]);
      // …and the id is simply absent, never refused.
      expect(out.has(subshellId)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("captures it for the owner", async () => {
    const { seen, spy } = watchCaptures();
    try {
      const out = await getRequestlessContext().services.subshells.previewsFor(ownerId, [subshellId]);
      expect(seen).toEqual([[subshellId]]);
      expect(out.get(subshellId)).toEqual(["screen"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("captures it for an admin, who holds instance-wide edit", async () => {
    const { seen, spy } = watchCaptures();
    try {
      await getRequestlessContext().services.subshells.previewsFor(adminId, [subshellId]);
      expect(seen).toEqual([[subshellId]]);
    } finally {
      spy.mockRestore();
    }
  });

  it("drops the ids a viewer may not see while keeping their own", async () => {
    const mine = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: mine,
      userId: strangerId,
      presetId: "p",
      harnessId: "claude-code",
      name: "my-session",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const { seen, spy } = watchCaptures();
    try {
      await getRequestlessContext().services.subshells.previewsFor(strangerId, [subshellId, mine]);
      expect(seen).toEqual([[mine]]);
    } finally {
      spy.mockRestore();
      await db.deleteFrom("subshells").where("id", "=", mine).execute();
    }
  });

  it("asks for no capture at all when the list is empty", async () => {
    const { seen, spy } = watchCaptures();
    try {
      expect((await getRequestlessContext().services.subshells.previewsFor(ownerId, [])).size).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
