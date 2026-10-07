import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { encodeSshSessionFrame, SSH_RUNTIME_PROTOCOL, SshSessionFrameDecoder } from "@internal/subshell-protocol";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import * as broker from "../local-broker.js";
import { getSession, resetSessionRegistryForTests } from "../session-registry.js";
import { openSession } from "../sessions.service.js";
import { closeSession } from "../sessions-lifecycle.js";

let userId: string;
const target = { alias: "dev", host: "dev.example", port: 22, user: null, identityFile: null };
const hello = {
  type: "hello" as const,
  runtimeProtocol: SSH_RUNTIME_PROTOCOL,
  agentVersion: "1.0",
  os: "linux",
  arch: "x64",
  capabilities: [],
  homeDir: "/home/dev",
  dataDir: "/home/dev/.subshell",
  tmuxSocket: "test",
  paneCount: 0,
};
const settings = new SettingsRepository(db);
const roles = new UserMetaRepository(db);
const opened = spyOn(broker, "openLocalBroker").mockResolvedValue({ hello, host: target.host, port: 22, user: null });
const closed = spyOn(broker, "closeLocalBroker").mockImplementation(() => {});
const sent = spyOn(broker, "sendLocalBroker").mockImplementation(async (id, bytes) => {
  const frames = new SshSessionFrameDecoder().push(bytes) as { ref: string }[];
  for (const frame of frames)
    getSession(id)?.ingestBytes(
      encodeSshSessionFrame({ type: "result", ref: frame.ref, ok: true, data: { subshells: [] } }),
    );
});

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email: `local-origin-${crypto.randomUUID()}@subshell.test`,
    name: "SSH admin",
    passwordHash: "unused",
    role: "admin",
  });
  const nodes = new NodesRepository(db);
  if (!(await nodes.findById("local")))
    await nodes.create({ id: "local", kind: "local", name: "Server", ownerUserId: userId });
});
afterAll(() => {
  opened.mockRestore();
  closed.mockRestore();
  sent.mockRestore();
  resetSessionRegistryForTests();
});

test("server-origin rejects members, disabled launching and maintenance before any SSH process", async () => {
  await roles.upsert({ userId, role: "user" });
  await expect(openSession(userId, { connectingNodeId: "local", target })).rejects.toMatchObject({ status: 404 });
  await roles.upsert({ userId, role: "admin" });
  await settings.set("allow_server_subshells", false);
  await expect(openSession(userId, { connectingNodeId: "local", target })).rejects.toMatchObject({ status: 409 });
  await settings.set("allow_server_subshells", true);
  await db.updateTable("nodes").set({ maintenance: 1 }).where("id", "=", "local").execute();
  await expect(openSession(userId, { connectingNodeId: "local", target })).rejects.toMatchObject({ status: 409 });
  await db.updateTable("nodes").set({ maintenance: 0 }).where("id", "=", "local").execute();
  expect(opened).not.toHaveBeenCalled();
});

test("admin uses the local byte channel without an enrolled node; close reaps its broker", async () => {
  const view = await openSession(userId, { connectingNodeId: "local", target });
  expect(view.status).toBe("active");
  expect(view.connectingNodeId).toBe("local");
  expect(opened).toHaveBeenCalledTimes(1);
  await getSession(view.id)?.command({ type: "list_dirs", ref: crypto.randomUUID(), path: "" }, 1000);
  expect(sent).toHaveBeenCalled();
  await closeSession(view.id, userId);
  expect(closed).toHaveBeenCalledWith(view.id);
});

test("removing admin access invalidates the channel rather than retaining server credentials", async () => {
  const view = await openSession(userId, { connectingNodeId: "local", target });
  const session = getSession(view.id);
  expect(session).toBeDefined();
  await roles.upsert({ userId, role: "user" });
  await expect(session?.command({ type: "list_dirs", ref: crypto.randomUUID(), path: "" }, 1000)).rejects.toBeDefined();
  expect(session?.status).toBe("lost");
  expect(closed).toHaveBeenCalledWith(view.id);
});
