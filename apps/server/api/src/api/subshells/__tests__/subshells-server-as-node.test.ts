import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { ALLOW_SERVER_SUBSHELLS_KEY } from "@/services/server-as-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The admin's `allow_server_subshells` off-switch (operator ask, 2026-09-24):
 * the control-plane host stops being a launch target WITHOUT a maintenance
 * window. Two surfaces must agree, which is why this is an HTTP test over the
 * real routes rather than the resolver in isolation:
 *
 *   - `POST /api/subshells` refuses a launch on the host (the gate), and
 *   - `GET /api/nodes/:id` reports `canLaunch: false` for the SAME host, so
 *     the picker greys/vanishes it rather than offering a doomed target.
 *
 * Distinct from `subshells-local-launch-off.test.ts` (that one is the SEED
 * SHARE being removed; this is a settings row) and from maintenance (a window
 * that kills panes). It restores the setting in `afterAll` because the row is
 * shared state for every other suite in the process.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(nodesRoutes);
const settings = new SettingsRepository(db);
const subshells = new SubshellsRepository(db);
const nodes = new NodesRepository(db);

async function setServerSubshells(on: boolean): Promise<void> {
  await settings.set(ALLOW_SERVER_SUBSHELLS_KEY, on);
}
async function clearServerSubshells(): Promise<void> {
  await db.deleteFrom("settings").where("key", "=", ALLOW_SERVER_SUBSHELLS_KEY).execute();
}

describe("the Server switched off as a node", () => {
  const pw = "san-pass-1";
  const adminEmail = `san-admin-${crypto.randomUUID()}@subshell.local`;
  let adminCookie = "";
  let adminId = "";
  let presetId = "";
  const insertedIds: string[] = [];
  let previousClaudePath: string | undefined;

  /** The local row's admin-chosen name, for the restart path's name-free rule. */
  async function localNodeName(): Promise<string | null> {
    return (await nodes.findById(LOCAL_NODE_ID))?.name ?? null;
  }

  beforeAll(async () => {
    // Same discipline as the share-off suite: the NODE gate is what's under
    // test, so nothing may reach the launcher. A bogus CLAUDE_PATH makes the
    // harness gate 409 on every machine once the node gate PASSES — which is
    // exactly how the "back on → launches again" case proves the flag cleared
    // without a real `claude` on a developer's box.
    previousClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = "/definitely/not/here/claude";
    await setupAuthTables();
    adminId = await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, pw);
    await ensureLocalNode(db);
    const preset = await new PresetsRepository(db).create({
      id: crypto.randomUUID(),
      userId: adminId,
      harnessId: "claude-code",
      name: `san-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    });
    presetId = preset.id;
  });

  afterAll(async () => {
    await clearServerSubshells();
    if (insertedIds.length > 0) {
      await db.deleteFrom("subshells").where("id", "in", insertedIds).execute();
    }
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    await deleteUserByEmailOrId(adminEmail);
    if (previousClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = previousClaudePath;
  });

  // async so Elysia's MaybePromise return coerces the same way the sibling
  // suite's `post`/`localView` helpers do.
  async function req(path: string, init?: RequestInit): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost:3080${path}`, {
        ...init,
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${adminCookie}` },
      }),
    );
  }
  const post = (body: unknown) => req("/api/subshells", { method: "POST", body: JSON.stringify(body) });
  const localView = async (): Promise<{ canLaunch: boolean; canManage: boolean; maintenance: boolean }> =>
    (await (await req(`/api/nodes/${LOCAL_NODE_ID}`)).json()) as {
      canLaunch: boolean;
      canManage: boolean;
      maintenance: boolean;
    };

  it("the absent row means ON: today's behavior, host launchable", async () => {
    await clearServerSubshells();
    expect((await localView()).canLaunch).toBe(true);
    // Past the node gate; the bogus CLAUDE_PATH makes the harness gate answer
    // next, which is proof the flag did NOT refuse.
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    expect(res.status).toBe(409); // the harness gate, reached only because the node gate PASSED
    // (a bogus CLAUDE_PATH makes it 409 everywhere — the honest signal; AGENTS
    // testing: 17 leaked panes came from exactly this "not 403" looseness);
  });

  it("an explicit launch on the host → 403 that names the SETTINGS, not shares", async () => {
    await setServerSubshells(false);
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/switched off/i);
    // Not the sharing-dialog sentence — that remedy ends nowhere when the
    // admin just moved the settings switch.
    expect(body.message).not.toMatch(/[Ss]hare/);
    expect(body.message).not.toMatch(/maintenance/i);
  });

  it("the node view reports canLaunch:false but STILL shows and manages it", async () => {
    await setServerSubshells(false);
    const view = await localView();
    expect(view.canLaunch).toBe(false);
    // The way back: it is not maintenance, it is visible, and the admin can
    // still drive it (this is the SAME row the switch lives on).
    expect(view.maintenance).toBe(false);
    expect(view.canManage).toBe(true);
  });

  it("an implicit launch declines the host and does NOT relocate onto it", async () => {
    await setServerSubshells(false);
    // No online agent in this harness ⇒ step 3 has nothing ⇒ NODE_REQUIRED,
    // never a silent landing on the switched-off host.
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp" });
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("NODE_REQUIRED");
  });

  it("back ON ⇒ the host is launchable again on both surfaces", async () => {
    await setServerSubshells(true);
    expect((await localView()).canLaunch).toBe(true);
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    // Past the node gate; the 409-harness from CLAUDE_PATH is the signal the
    // flag cleared (a 403 would mean it is still refusing).
    expect(res.status).toBe(409); // the harness gate, reached only because the node gate PASSED
    // (a bogus CLAUDE_PATH makes it 409 everywhere — the honest signal; AGENTS
    // testing: 17 leaked panes came from exactly this "not 403" looseness);
  });

  it("a restart on the switched-off host is refused too, naming no machine", async () => {
    // "A restart IS a launch, and this path never touches resolveLaunchNode"
    // (subshells.service.ts) — so the switch needs its own assertion here,
    // or restart becomes the one way to start a pane on a host that is
    // refusing them. The name-free message is the restart path's own rule:
    // an edit grantee on a shared subshell may not be able to SEE the node.
    await setServerSubshells(false);
    const id = crypto.randomUUID();
    insertedIds.push(id);
    await subshells.create({
      id,
      userId: adminId,
      presetId,
      harnessId: "claude-code",
      name: `san-${id.slice(0, 8)}`,
      workingDir: "/tmp",
      tmuxSocket: `san-sock-${id}`,
      nodeId: LOCAL_NODE_ID,
      alive: 0,
    });
    const res = await req(`/api/subshells/${id}/restart`, { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/switched off/i);
    const localName = (await localNodeName()) ?? "";
    if (localName) expect(body.message).not.toContain(localName);
  });
});
