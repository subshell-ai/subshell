import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { effectiveViewerAccess } from "@/services/subshells.service.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The ssh view truth (spec 2026-10-07 §5.4, plan 3 decision 1): an ssh pane
 * reads as `view` + `ssh: true` to EVERY non-owner in both view paths (GET
 * detail and GET list, the same two doors the MCP `get_subshell`/
 * `list_subshells` read through), while enforcement itself stays where tier 2
 * put it (`paneInputAllowed` at the input doors). Ordinary panes are
 * untouched: an `edit` grantee still reads `edit`. Owner and `view` pass
 * through unchanged. The downgrade must never widen anything: it keys on the
 * snapshot column's PRESENCE, not its content.
 */
describe("ssh panes in subshell views: the non-owner access downgrade", () => {
  const pw = "ssh-view-1";
  const aliceEmail = `sv-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `sv-bob-${crypto.randomUUID()}@subshell.local`;
  const carolEmail = `sv-carol-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `sv-admin-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;
  const created: string[] = [];

  async function mkUser(email: string, role: "user" | "admin"): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  }
  /** Alice owns every fixture row; `ssh` rides the row exactly as launch writes it. */
  async function ownSubshell(id: string, ssh: string | null = null): Promise<void> {
    created.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId: aliceId,
      presetId: "p",
      harnessId: "ssh",
      name: id,
      workingDir: "/tmp",
      tmuxSocket: null,
      ssh,
    });
  }

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await mkUser(aliceEmail, "user");
    bobId = await mkUser(bobEmail, "user");
    carolId = await mkUser(carolEmail, "user");
    await mkUser(adminEmail, "admin"); // signed in per test (mirrors the sharing matrix file)
    aliceCookie = await signIn(aliceEmail, pw);
    bobCookie = await signIn(bobEmail, pw);
    carolCookie = await signIn(carolEmail, pw);

    // The snapshot content is irrelevant to the rule (presence is the kind
    // fact); this one is valid JSON so the fixture also reads plausibly.
    await ownSubshell("s_ssh", JSON.stringify({ destination: "dev.example.com", node: "local" }));
    await ownSubshell("s_plain"); // ordinary pane: ssh NULL
    const shares = new SubshellSharesRepository(db);
    await shares.replaceForSubshell(
      "s_ssh",
      [
        { granteeUserId: bobId, permission: "edit" },
        { granteeUserId: carolId, permission: "view" },
      ],
      aliceId,
    );
    await shares.replaceForSubshell("s_plain", [{ granteeUserId: bobId, permission: "edit" }], aliceId);
  });

  afterAll(async () => {
    for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const email of [aliceEmail, bobEmail, carolEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  function req(method: string, path: string, cookie: string) {
    return subshellRoutes.fetch(
      new Request(`http://localhost:3080/api/subshells${path}`, {
        method,
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }
  async function get(path: string, cookie: string) {
    return (await (await req("GET", path, cookie)).json()) as { access: string; ssh: boolean };
  }

  it("an edit grantee GETs an ssh pane as view-only: access 'view', ssh true (detail path)", async () => {
    const got = await get("/s_ssh", bobCookie);
    expect(got.access).toBe("view");
    expect(got.ssh).toBe(true);
  });

  it("the owner keeps access 'owner' and sees ssh true", async () => {
    const got = await get("/s_ssh", aliceCookie);
    expect(got.access).toBe("owner");
    expect(got.ssh).toBe(true);
  });

  it("a view grantee is unchanged (already view), and still learns ssh", async () => {
    const got = await get("/s_ssh", carolCookie);
    expect(got.access).toBe("view");
    expect(got.ssh).toBe(true);
  });

  it("an ordinary pane is untouched: the edit grantee still reads access 'edit', ssh false", async () => {
    const got = await get("/s_plain", bobCookie);
    expect(got.access).toBe("edit");
    expect(got.ssh).toBe(false);
  });

  it("the admin's effective edit on a foreign ssh pane reads as view too (the boost is not ownership)", async () => {
    const cookie = await signIn(adminEmail, pw);
    try {
      const sshRow = await get("/s_ssh", cookie);
      expect(sshRow.access).toBe("view");
      expect(sshRow.ssh).toBe(true);
      // Same admin, ordinary pane: still the resolved `edit` (pinning that the
      // downgrade is keyed to the ssh column, not to the viewer's role).
      const plain = await get("/s_plain", cookie);
      expect(plain.access).toBe("edit");
      expect(plain.ssh).toBe(false);
    } finally {
      await deleteUserByEmailOrId(adminEmail);
    }
  });

  it("the LIST path downgrades the same way (one helper, both doors; the MCP list rides this route)", async () => {
    const rows = (await (await req("GET", "", bobCookie)).json()) as {
      id: string;
      access: string;
      ssh: boolean;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("s_ssh")).toMatchObject({ access: "view", ssh: true });
    expect(byId.get("s_plain")).toMatchObject({ access: "edit", ssh: false });
  });
});

describe("effectiveViewerAccess (the downgrade helper, exported for test)", () => {
  const sshRow = { ssh: "x", userId: "owner-1" }; // presence keys the rule: content never parsed
  const plainRow = { ssh: null, userId: "owner-1" };

  it("downgrades edit to view on an ssh row", () => {
    expect(effectiveViewerAccess(sshRow, "edit")).toBe("view");
  });
  it("leaves owner and view as resolved on an ssh row", () => {
    expect(effectiveViewerAccess(sshRow, "owner")).toBe("owner");
    expect(effectiveViewerAccess(sshRow, "view")).toBe("view");
  });
  it("leaves every level as resolved on an ordinary row", () => {
    expect(effectiveViewerAccess(plainRow, "edit")).toBe("edit");
    expect(effectiveViewerAccess(plainRow, "owner")).toBe("owner");
    expect(effectiveViewerAccess(plainRow, "view")).toBe("view");
  });
});
