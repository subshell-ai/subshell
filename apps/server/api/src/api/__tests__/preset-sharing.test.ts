import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { presetRoutes } from "@/api/presets.route.js";
import { db } from "@/db/index.js";
import { PresetSharesRepository } from "@/db/repositories/preset-shares.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SshPresetsRepository } from "@/db/repositories/ssh-presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { presetAccess } from "@/lib/preset-access.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { FakeNodeLauncher } from "@/services/__tests__/helpers/node-fakes.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

type PresetView = { id: string; access: string; ownerName: string; envJson: string | null };
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const app = new Elysia().use(errorHandlerPlugin).use(presetRoutes);
const agents = new PresetsRepository(db);
const ssh = new SshPresetsRepository(db);
const grants = new PresetSharesRepository(db);
type Person = { id: string; cookie: string };
const people: Person[] = [];
let owner: Person;
let viewer: Person;
let stranger: Person;
let key: string;
let pane: string;
function request(person: Person, path: string, method = "GET", body?: unknown) {
  return app.fetch(
    authedRequest(`/api/presets${path}`, person.cookie, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
function share(id: string, shares: { granteeUserId: string | null; permission: "view" | "edit" }[]) {
  return request(owner, `/${id}/shares`, "PUT", { shares });
}
async function seed(kind: "agent" | "ssh") {
  if (kind === "agent")
    return seedPreset(agents, {
      userId: owner.id,
      harnessId: "terminal",
      name: crypto.randomUUID(),
      envJson: '{"SECRET":"visible-to-grantees"}',
    });
  const id = crypto.randomUUID();
  await ssh.create({
    id,
    userId: owner.id,
    name: id,
    description: null,
    nodeId: "local",
    destination: "host.example:22",
    alias: null,
    resolutionAlias: "host.example:22",
    authentication: "password",
    keyHome: null,
    fingerprints: null,
    forwards: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}
beforeAll(async () => {
  await setupAuthTables();
  await ensureLocalNode(db);
  for (let index = 0; index < 3; index++) {
    const email = `preset-share-${crypto.randomUUID()}@example.test`;
    const password = "Preset-sharing-test-2026!";
    const id = await new UsersRepository(db).createUser({
      email,
      name: `Person ${index}`,
      passwordHash: await hashPassword(password),
      role: index === 2 ? "admin" : "user",
    });
    people.push({ id, cookie: await signIn(email, password) });
  }
  [owner, viewer, stranger] = people as [Person, Person, Person];
  pane = crypto.randomUUID();
  await new SubshellsRepository(db).create({
    id: pane,
    userId: viewer.id,
    presetId: null,
    harnessId: "terminal",
    name: "Sharing test",
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  key = await issueSubshellToken(pane, viewer.id);
});
afterAll(async () => {
  await db.deleteFrom("subshells").where("id", "=", pane).execute();
  for (const person of people) await deleteUserByEmailOrId(person.id);
});
for (const kind of ["agent", "ssh"] as const)
  describe(`${kind} preset sharing`, () => {
    it("keeps private rows hidden, grants view without writes, and preserves ownership on edit", async () => {
      const id = await seed(kind);
      expect((await request(stranger, `/${id}/shares`)).status).toBe(404);
      expect(
        (await json<PresetView[]>(await request(viewer, `?kind=${kind}`))).some((row: { id: string }) => row.id === id),
      ).toBe(false);
      expect((await share(id, [{ granteeUserId: viewer.id, permission: "view" }])).status).toBe(200);
      const rows = await json<PresetView[]>(await request(viewer, `?kind=${kind}`));
      const row = rows.find((row: { id: string }) => row.id === id);
      expect(row?.access).toBe("view");
      expect(row?.ownerName).toBe("Person 0");
      if (kind === "agent") expect(row?.envJson).toContain("visible-to-grantees");
      const update =
        kind === "agent"
          ? { name: "Edited agent" }
          : { name: "Edited SSH", nodeId: "local", destination: "host.example:22", authentication: "password" };
      expect((await request(viewer, `/${id}`, "PUT", update)).status).toBe(403);
      expect((await request(viewer, `/${id}`, "DELETE")).status).toBe(404);
      expect((await request(viewer, `/${id}/shares`, "PUT", { shares: [] })).status).toBe(403);
      await share(id, [{ granteeUserId: viewer.id, permission: "edit" }]);
      const edited = await request(viewer, `/${id}`, "PUT", update);
      expect(edited.status).toBe(200);
      expect(await json<PresetView>(edited)).toMatchObject({ access: "edit", ownerName: "Person 0" });
      expect((kind === "agent" ? await agents.findById(id) : await ssh.findById(id))?.userId).toBe(owner.id);
      expect((await request(viewer, `/${id}/shares`)).status).toBe(403);
      expect((await request(viewer, `/${id}`, "DELETE")).status).toBe(404);
      await share(id, []);
      expect(
        (await json<PresetView[]>(await request(viewer, `?kind=${kind}`))).some((row: { id: string }) => row.id === id),
      ).toBe(false);
      expect((await request(viewer, `/${id}`, "PUT", update)).status).toBe(404);
    });
    it("combines Everyone and named grants, rejects unknown users atomically, and cascades deletion", async () => {
      const id = await seed(kind);
      expect(
        (
          await share(id, [
            { granteeUserId: null, permission: "view" },
            { granteeUserId: viewer.id, permission: "edit" },
          ])
        ).status,
      ).toBe(200);
      const row = kind === "agent" ? await agents.findById(id) : await ssh.findById(id);
      if (!row) throw new Error("Missing fixture");
      expect(await presetAccess(db, kind, row, viewer.id)).toBe("edit");
      expect(await presetAccess(db, kind, row, stranger.id)).toBe("view");
      expect(await presetAccess(db, kind, row, viewer.id, false)).toBe("none");
      expect((await share(id, [{ granteeUserId: "missing-user", permission: "edit" }])).status).toBe(400);
      expect((await grants.list(kind, [id])).length).toBe(2);
      expect((await request(owner, `/${id}`, "DELETE")).status).toBe(200);
      expect(await grants.list(kind, [id])).toEqual([]);
    });
    it("refuses bearer sharing and never lists shared rows to machine actors", async () => {
      const id = await seed(kind);
      await share(id, [{ granteeUserId: viewer.id, permission: "edit" }]);
      for (const method of ["GET", "PUT"]) {
        const response = await app.fetch(
          new Request(`http://localhost:3080/api/presets/${id}/shares`, {
            method,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            ...(method === "PUT" ? { body: JSON.stringify({ shares: [] }) } : {}),
          }),
        );
        expect(response.status).toBe(403);
      }
      const response = await app.fetch(
        new Request(`http://localhost:3080/api/presets?kind=${kind}`, { headers: { authorization: `Bearer ${key}` } }),
      );
      if (kind === "ssh") expect(response.status).toBe(403);
      else expect((await json<PresetView[]>(response)).some((row: { id: string }) => row.id === id)).toBe(false);
    });
  });

it("uses a view-shared agent preset for browser launches and rechecks access on restart", async () => {
  const id = await seed("agent");
  await share(id, [{ granteeUserId: viewer.id, permission: "view" }]);
  const launcher = new FakeNodeLauncher("/tmp");
  const subshells = new SubshellsRepository(db);
  const manager = new SubshellManagerService({
    subshells,
    presets: agents,
    launcher,
    tokens: { issue: async () => "test-key", revoke: async () => {} },
    audit: async () => {},
    notify: async () => {},
  });
  const input = { userId: viewer.id, harnessId: "terminal", presetId: id, workingDir: "/tmp" };
  await expect(manager.createSubshell(input)).rejects.toThrow("Preset not found");
  const created = await manager.createSubshell({ ...input, allowSharedPreset: true });
  try {
    expect(launcher.plans).toHaveLength(1);
    await manager.restartSubshell(viewer.id, created.id);
    expect(launcher.plans).toHaveLength(2);
    await share(id, []);
    const killsBeforeRevocation = launcher.kills.length;
    await expect(
      getRequestlessContext().services.subshells.restartSubshell(viewer.id, created.id, "cookie"),
    ).rejects.toThrow("Preset access was removed");
    expect((await subshells.findById(created.id))?.alive).toBe(1);
    await expect(manager.restartSubshell(viewer.id, created.id)).rejects.toThrow("Preset access was removed");
    expect(launcher.plans).toHaveLength(2);
    expect(launcher.kills).toHaveLength(killsBeforeRevocation);
  } finally {
    await subshells.delete(created.id);
  }
});

it("shared presets do not bypass node access or machine-actor restrictions", async () => {
  const id = await seed("agent");
  await share(id, [{ granteeUserId: viewer.id, permission: "view" }]);
  const service = getRequestlessContext().services.subshells;
  const input = {
    userId: viewer.id,
    harnessId: "terminal",
    presetId: id,
    workingDir: "/tmp",
    nodeId: "inaccessible-node",
    crossAgent: false,
  };
  await expect(service.createSubshell({ ...input, machineActor: true })).rejects.toThrow("Preset not found");
  await expect(service.createSubshell({ ...input, machineActor: false })).rejects.toThrow("Node not found");
});
