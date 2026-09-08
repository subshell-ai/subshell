import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { workspaceRoutes } from "@/api/workspaces/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** Creates a profile + subshell owned by `userId`, returning the subshell id. */
async function makeSubshell(userId: string): Promise<string> {
  const profile = await new ProfilesRepository(db).create({
    id: crypto.randomUUID(),
    userId,
    harnessId: "claude-code",
    name: `p-${crypto.randomUUID().slice(0, 8)}`,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
  });
  const id = crypto.randomUUID();
  await new SubshellsRepository(db).create({
    id,
    userId,
    profileId: profile.id,
    harnessId: "claude-code",
    name: "s",
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  return id;
}

/**
 * Workspace CRUD is owner-scoped rather than admin-gated: another user's
 * workspace must read as 404, not 403, so ids cannot be probed.
 */
describe("workspaces route", () => {
  let ownerId: string;
  let otherId: string;
  let ownerEmail: string;
  let otherEmail: string;
  const password = "workspace-pass-1";

  beforeAll(async () => {
    await setupAuthTables();
    const repo = new UsersRepository(db);
    ownerEmail = `wsowner-${crypto.randomUUID()}@subshell.local`;
    otherEmail = `wsother-${crypto.randomUUID()}@subshell.local`;
    ownerId = await repo.createUser({ email: ownerEmail, passwordHash: await hashPassword(password), role: "user" });
    otherId = await repo.createUser({ email: otherEmail, passwordHash: await hashPassword(password), role: "user" });
  });

  beforeEach(async () => {
    await db.deleteFrom("workspacePanes").execute();
    await db.deleteFrom("workspaces").execute();
  });

  afterAll(async () => {
    await db.deleteFrom("subshells").where("userId", "in", [ownerId, otherId]).execute();
    await db.deleteFrom("profiles").where("userId", "in", [ownerId, otherId]).execute();
    await db.deleteFrom("userMeta").where("userId", "=", ownerId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", otherId).execute();
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(otherEmail);
  });

  /** POSTs a workspace and returns its id. */
  async function createWorkspace(token: string, name: string): Promise<string> {
    const res = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", token, { method: "POST", body: JSON.stringify({ name }) }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  it("anonymous -> 401", async () => {
    const res = await workspaceRoutes.fetch(new Request("http://localhost:3080/api/workspaces"));
    expect(res.status).toBe(401);
  });

  it("creates a workspace and lists it back", async () => {
    const token = await signIn(ownerEmail, password);
    const name = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const id = await createWorkspace(token, name);

    const list = await workspaceRoutes.fetch(authedRequest("/api/workspaces", token));
    const body = (await list.json()) as { id: string; name: string }[];
    expect(body.some((w) => w.id === id && w.name === name)).toBe(true);
  });

  it("duplicate name for the same user -> 409, but another user may reuse it", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const otherToken = await signIn(otherEmail, password);
    const name = `dup-${crypto.randomUUID().slice(0, 8)}`;
    await createWorkspace(ownerToken, name);

    const dup = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", ownerToken, { method: "POST", body: JSON.stringify({ name }) }),
    );
    expect(dup.status).toBe(409);

    const otherRes = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", otherToken, { method: "POST", body: JSON.stringify({ name }) }),
    );
    expect(otherRes.status).toBe(200);
  });

  it("another user's workspace reads as 404, not 403", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const otherToken = await signIn(otherEmail, password);
    const id = await createWorkspace(ownerToken, `private-${crypto.randomUUID().slice(0, 8)}`);

    const read = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, otherToken));
    expect(read.status).toBe(404);

    const del = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, otherToken, { method: "DELETE" }));
    expect(del.status).toBe(404);
  });

  it("a pane cannot point at a subshell the caller does not own", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const id = await createWorkspace(ownerToken, `panes-${crypto.randomUUID().slice(0, 8)}`);

    const res = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, ownerToken, {
        method: "POST",
        body: JSON.stringify({ subshellId: crypto.randomUUID() }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("a pane cannot point at a real subshell owned by another user", async () => {
    // Unlike the previous test (a subshell id that was never created), this
    // exercises the `subshell.userId !== user.id` branch specifically: the
    // subshell exists, just not for the caller. Without this test, deleting
    // that ownership check outright would leave the suite green.
    const ownerToken = await signIn(ownerEmail, password);
    const id = await createWorkspace(ownerToken, `foreign-subshell-${crypto.randomUUID().slice(0, 8)}`);
    const otherSubshellId = await makeSubshell(otherId);

    const res = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, ownerToken, {
        method: "POST",
        body: JSON.stringify({ subshellId: otherSubshellId }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("a pane MAY point at a subshell shared to the caller (spec §4.3), while an unshared one still 404s", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const id = await createWorkspace(ownerToken, `shared-subshell-${crypto.randomUUID().slice(0, 8)}`);
    const otherSubshellId = await makeSubshell(otherId);
    // other shares it with Everyone → visible (view) to owner.
    await new SubshellSharesRepository(db).replaceForSubshell(
      otherSubshellId,
      [{ granteeUserId: null, permission: "view" }],
      otherId,
    );

    const ok = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, ownerToken, {
        method: "POST",
        body: JSON.stringify({ subshellId: otherSubshellId }),
      }),
    );
    expect(ok.status).toBe(200);

    // A DIFFERENT foreign subshell, unshared, is still invisible → 404.
    const unshared = await makeSubshell(otherId);
    const bad = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, ownerToken, {
        method: "POST",
        body: JSON.stringify({ subshellId: unshared }),
      }),
    );
    expect(bad.status).toBe(404);
  });

  it("removes a pane, and removing it again 404s", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const id = await createWorkspace(ownerToken, `remove-pane-${crypto.randomUUID().slice(0, 8)}`);
    const subshellId = await makeSubshell(ownerId);

    const added = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, ownerToken, {
        method: "POST",
        body: JSON.stringify({ subshellId }),
      }),
    );
    expect(added.status).toBe(200);
    const paneId = ((await added.json()) as { id: string }).id;

    const beforeDelete = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, ownerToken));
    expect(((await beforeDelete.json()) as { panes: { id: string }[] }).panes.map((p) => p.id)).toContain(paneId);

    const del = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes/${paneId}`, ownerToken, { method: "DELETE" }),
    );
    expect(del.status).toBe(200);

    const afterDelete = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, ownerToken));
    expect(((await afterDelete.json()) as { panes: { id: string }[] }).panes.map((p) => p.id)).not.toContain(paneId);

    const redelete = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes/${paneId}`, ownerToken, { method: "DELETE" }),
    );
    expect(redelete.status).toBe(404);
  });

  it("pane rows carry the subshell's exit code (null while running, the code once dead)", async () => {
    // The exited-pane panel in a workspace renders the same LogTail as the
    // detail page, and LogTail names the exit code in its headline — that
    // needs `exit_code` on the joined pane row, not just on the subshell.
    const token = await signIn(ownerEmail, password);
    const id = await createWorkspace(token, `exitcode-${crypto.randomUUID().slice(0, 8)}`);
    const subshellId = await makeSubshell(ownerId);
    const added = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, token, {
        method: "POST",
        body: JSON.stringify({ subshellId }),
      }),
    );
    expect(added.status).toBe(200);

    type PaneRow = { subshellId: string; subshellAlive: boolean; subshellExitCode: number | null };
    const readPanes = async (): Promise<PaneRow[]> => {
      const res = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, token));
      return ((await res.json()) as { panes: PaneRow[] }).panes;
    };

    // Alive subshell: the field is present and null (never omitted — the
    // frontend types it non-optional).
    const [live] = await readPanes();
    expect(live?.subshellAlive).toBe(true);
    expect(live?.subshellExitCode).toBeNull();

    // The reconcile loop records the code when it finds a dead pane
    // (subshell-manager.service.ts); simulate that write.
    await new SubshellsRepository(db).update(subshellId, { alive: 0, exitCode: 137 });
    const [dead] = await readPanes();
    expect(dead?.subshellAlive).toBe(false);
    expect(dead?.subshellExitCode).toBe(137);
  });

  it("pane rows carry the subshell's waiting_since stamp (dock-tab waiting chip)", async () => {
    // The dock tab decorates a waiting subshell's title from the joined pane
    // row — the same pattern as subshellExitCode — so the stamp must ride the
    // workspace detail join, present-and-null when not waiting.
    const token = await signIn(ownerEmail, password);
    const id = await createWorkspace(token, `waiting-${crypto.randomUUID().slice(0, 8)}`);
    const subshellId = await makeSubshell(ownerId);
    const added = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, token, {
        method: "POST",
        body: JSON.stringify({ subshellId }),
      }),
    );
    expect(added.status).toBe(200);

    type PaneRow = { subshellId: string; subshellWaitingSince: string | null };
    const readPanes = async (): Promise<PaneRow[]> => {
      const res = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, token));
      return ((await res.json()) as { panes: PaneRow[] }).panes;
    };

    const [notWaiting] = await readPanes();
    expect(notWaiting?.subshellWaitingSince).toBeNull();

    // The attention endpoint / idle watcher stamp this column (see
    // subshells.service.recordAttention); simulate the write.
    const stamp = "2026-08-30T10:00:00.000Z";
    await new SubshellsRepository(db).update(subshellId, { waitingSince: stamp });
    const [waiting] = await readPanes();
    expect(waiting?.subshellWaitingSince).toBe(stamp);
  });

  it("saves and returns a layout, pruning panels whose pane is gone", async () => {
    const token = await signIn(ownerEmail, password);
    const id = await createWorkspace(token, `layout-${crypto.randomUUID().slice(0, 8)}`);
    const subshellId = await makeSubshell(ownerId);
    const paneRes = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, token, {
        method: "POST",
        body: JSON.stringify({ subshellId }),
      }),
    );
    const paneId = ((await paneRes.json()) as { id: string }).id;

    // A layout naming the real pane plus one that no longer exists.
    const layout = {
      grid: {
        root: {
          type: "branch",
          data: [
            { type: "leaf", data: { views: [paneId], activeView: paneId }, size: 500 },
            { type: "leaf", data: { views: ["ghost"], activeView: "ghost" }, size: 500 },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { [paneId]: { id: paneId }, ghost: { id: "ghost" } },
    };
    const put = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/layout`, token, { method: "PUT", body: JSON.stringify({ layout }) }),
    );
    expect(put.status).toBe(200);

    const read = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, token));
    const body = (await read.json()) as { workspace: { layout: { panels: Record<string, unknown> } | null } };
    // "ghost" had no pane row and must not come back.
    expect(Object.keys(body.workspace.layout?.panels ?? {})).toEqual([paneId]);
  });

  it("another user's layout save -> 404 (not 403)", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const otherToken = await signIn(otherEmail, password);
    const id = await createWorkspace(ownerToken, `lay404-${crypto.randomUUID().slice(0, 8)}`);
    const res = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/layout`, otherToken, {
        method: "PUT",
        body: JSON.stringify({ layout: { grid: {}, panels: {} } }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("subshellCount tracks the panes on create, list, detail, and update", async () => {
    const token = await signIn(ownerEmail, password);
    const createRes = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name: `count-${crypto.randomUUID().slice(0, 8)}` }),
      }),
    );
    const created = (await createRes.json()) as { id: string; subshellCount: number };
    // A brand-new workspace cannot have panes.
    expect(created.subshellCount).toBe(0);
    const id = created.id;

    for (let i = 0; i < 2; i++) {
      const subshellId = await makeSubshell(ownerId);
      const add = await workspaceRoutes.fetch(
        authedRequest(`/api/workspaces/${id}/panes`, token, { method: "POST", body: JSON.stringify({ subshellId }) }),
      );
      expect(add.status).toBe(200);
    }

    const listRes = await workspaceRoutes.fetch(authedRequest("/api/workspaces", token));
    const list = (await listRes.json()) as { id: string; subshellCount: number }[];
    expect(list.find((w) => w.id === id)?.subshellCount).toBe(2);

    const detailRes = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, token));
    const detail = (await detailRes.json()) as { workspace: { subshellCount: number }; panes: unknown[] };
    expect(detail.workspace.subshellCount).toBe(detail.panes.length);

    const putRes = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}`, token, {
        method: "PUT",
        body: JSON.stringify({ name: "renamed-count" }),
      }),
    );
    const updated = (await putRes.json()) as { subshellCount: number };
    expect(updated.subshellCount).toBe(2);
  });

  // F4 (security audit 2026-08): /api/workspaces is a browser-only surface —
  // the `subshell mcp` binary never calls it (see the endpoint census in
  // packages/mcp-core/src/tools.ts), so a bearer key (any grants, any owner) must not act
  // as the owner here. The frontend reaches it cookie-only via apiFetch.
  describe("bearer keys are locked out (cookie-only surface)", () => {
    it("subshell bearer GET/POST /api/workspaces -> 403; cookie GET stays 200", async () => {
      const subshellId = await makeSubshell(ownerId);
      const key = await issueSubshellToken(subshellId, ownerId);
      const apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId;

      const list = await workspaceRoutes.fetch(
        new Request("http://localhost:3080/api/workspaces", { headers: { authorization: `Bearer ${key}` } }),
      );
      expect(list.status).toBe(403);

      const create = await workspaceRoutes.fetch(
        new Request("http://localhost:3080/api/workspaces", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "bearer-ws" }),
        }),
      );
      expect(create.status).toBe(403);

      // Positive control: the same cookie actor keeps working.
      const ownerToken = await signIn(ownerEmail, password);
      const cookieRes = await workspaceRoutes.fetch(authedRequest("/api/workspaces", ownerToken));
      expect(cookieRes.status).toBe(200);

      if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    });
  });
});
