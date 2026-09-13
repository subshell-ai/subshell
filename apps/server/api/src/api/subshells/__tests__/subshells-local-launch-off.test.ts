import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * Switching off launching on the control-plane host applies to ADMINS too
 * (operator's call, 2026-09-12).
 *
 * The switch is the removal of `local`'s seeded Everyone/`edit` row, and
 * `resolveNodeAccess` ranks every admin at `edit` on every node — so before
 * this, the one person who could turn the switch off was the one person it
 * never applied to, and the setting quietly meant something different for
 * whoever set it.
 *
 * The admin must still SEE the node, or there would be no way back: this is
 * the one visible-but-unlaunchable row in the product, which is why the
 * refusal is a 403 and not the 404 an invisible node answers with.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(nodesRoutes);
const shares = new NodeSharesRepository(db);

describe("launching on the server, switched off", () => {
  const pw = "loff-pass-1";
  const adminEmail = `loff-admin-${crypto.randomUUID()}@subshell.local`;
  let adminCookie = "";
  let adminId = "";
  let presetId = "";
  let systemId = "";

  /** Drop every Everyone row, keeping any per-user grant — the switch's own write. */
  async function setLocalLaunch(on: boolean): Promise<void> {
    await shares.replaceForNode(LOCAL_NODE_ID, on ? [{ granteeUserId: null, permission: "edit" }] : [], systemId);
  }

  beforeAll(async () => {
    await setupAuthTables();
    adminId = await new UsersRepository(db).createUser({
      email: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, pw);
    systemId = await ensureSystemUser();
    await ensureLocalNode(db);
    const preset = await new PresetsRepository(db).create({
      id: crypto.randomUUID(),
      userId: adminId,
      harnessId: "claude-code",
      name: `loff-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    });
    presetId = preset.id;
  });

  afterAll(async () => {
    // The seeded grant is shared state for every other suite in this process.
    await setLocalLaunch(true);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    await deleteUserByEmailOrId(adminEmail);
  });

  async function post(body: unknown): Promise<Response> {
    return app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${adminCookie}` },
        body: JSON.stringify(body),
      }),
    );
  }

  async function localView(): Promise<{ canLaunch: boolean; canManage: boolean }> {
    const res = await app.fetch(
      new Request(`http://localhost:3080/api/nodes/${LOCAL_NODE_ID}`, {
        headers: { cookie: `better-auth.session_token=${adminCookie}` },
      }),
    );
    return (await res.json()) as { canLaunch: boolean; canManage: boolean };
  }

  it("refuses an admin's explicit launch with 403, not the 404 an invisible node gets", async () => {
    await setLocalLaunch(false);
    const res = await post({ presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/switched off/i);
  });

  it("still shows the node to the admin, and still lets them manage it", async () => {
    await setLocalLaunch(false);
    // The way back. A 404 here would leave the switch unreachable from the UI
    // that turned it off.
    const view = await localView();
    expect(view.canManage).toBe(true);
    expect(view.canLaunch).toBe(false);
  });

  it("stops defaulting to the host when no node is named", async () => {
    await setLocalLaunch(false);
    const res = await post({ presetId, workingDir: "/tmp" });
    // Past `local`, through the single-online-agent step, and out: there is
    // nothing to launch on. Never a silent fallback to the host the admin
    // just switched off.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_REQUIRED");
  });

  it("lets the admin launch again the moment the grant is back", async () => {
    await setLocalLaunch(true);
    expect((await localView()).canLaunch).toBe(true);
    const res = await post({ presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    // Past the node gate entirely — whatever answers now is about the harness
    // or the directory, never about the node.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });
});
