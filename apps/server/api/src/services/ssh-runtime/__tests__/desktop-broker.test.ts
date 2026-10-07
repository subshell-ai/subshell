import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SSH_RUNTIME_PROTOCOL } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sshRuntimeRoutes } from "@/api/ssh-runtime/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { desktopBrokerWsPlugin } from "@/ws/desktop-broker.plugin.js";
import {
  attachDesktopBroker,
  authenticateDesktopBroker,
  type DesktopLink,
  desktopCommand,
  desktopOwnerLive,
  listDesktopBrokers,
  pairDesktopBroker,
  parseDesktopCommand,
  revokeDesktopBroker,
} from "../desktop-broker.js";
import { sshDiscovery } from "../discovery.service.js";
import { openSession } from "../sessions.service.js";

let owner: string;
let foreign: string;
let cookie: string;
const ids: string[] = [];
const links: DesktopLink[] = [];
const password = "desktop-broker-testing-password";
beforeAll(async () => {
  await setupAuthTables();
  const users = new UsersRepository(db);
  const email = `desktop-owner-${crypto.randomUUID()}@example.test`;
  owner = await users.createUser({
    email,
    name: "Desktop owner",
    passwordHash: await hashPassword(password),
    role: "user",
  });
  foreign = await users.createUser({
    email: `desktop-foreign-${crypto.randomUUID()}@example.test`,
    name: "Other account",
    passwordHash: await hashPassword(password),
    role: "admin",
  });
  cookie = await signIn(email, password);
});
afterAll(async () => {
  for (const link of links) link.close();
  await db.deleteFrom("nodes").where("id", "in", ids).execute();
  await deleteUserByEmailOrId(owner);
  await deleteUserByEmailOrId(foreign);
});
async function pairing() {
  const value = await pairDesktopBroker(owner, { name: `Desktop ${crypto.randomUUID().slice(0, 8)}` });
  ids.push(value.id);
  return value;
}
async function attach() {
  const pair = await pairing();
  const identity = await authenticateDesktopBroker(`Bearer ${pair.pairingToken}`);
  const frames: Record<string, unknown>[] = [];
  const link = await attachDesktopBroker(identity, {
    send: (value) => {
      frames.push(JSON.parse(value));
    },
    close: () => {},
  });
  links.push(link);
  return { pair, identity, frames, link };
}
test("pair token is single use, short lived, invisible to ordinary REST auth", async () => {
  const pair = await pairing();
  expect(Date.parse(pair.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
  await authenticateDesktopBroker(`Bearer ${pair.pairingToken}`);
  await expect(authenticateDesktopBroker(`Bearer ${pair.pairingToken}`)).rejects.toThrow();
  const app = new Elysia().use(errorHandlerPlugin).use(sshRuntimeRoutes);
  const response = await app.fetch(
    new Request("http://localhost/api/ssh-runtime/desktop-brokers", {
      headers: { authorization: `Bearer ${pair.pairingToken}` },
    }),
  );
  expect(response.status).toBe(401);
});
test("owner isolation includes admin accounts and preserves stable resume identity", async () => {
  const { pair, identity, link } = await attach();
  expect(await desktopOwnerLive(pair.id, owner)).toBe(true);
  expect(await desktopOwnerLive(pair.id, foreign)).toBe(false);
  expect((await listDesktopBrokers(foreign)).brokers).toEqual([]);
  await expect(pairDesktopBroker(foreign, { name: "Foreign", id: pair.id })).rejects.toThrow();
  await expect(revokeDesktopBroker(foreign, pair.id)).rejects.toThrow();
  const credential = identity.credential;
  if (!credential) throw new Error("Pairing did not mint a credential.");
  const row = await new NodesRepository(db).findById(pair.id);
  expect(row?.publicKey).not.toBe(credential);
  link.close();
  const resumed = await authenticateDesktopBroker(`Bearer ${credential}`);
  expect(resumed.id).toBe(pair.id);
  await revokeDesktopBroker(owner, pair.id);
  await expect(authenticateDesktopBroker(`Bearer ${credential}`)).rejects.toThrow();
});
test("detached links cannot enqueue; drop rejects pending requests; arbitrary commands refused", async () => {
  const pair = await pairing();
  await expect(desktopCommand(pair.id, { type: "ssh_discover_aliases" })).rejects.toThrow();
  const { link, frames } = await attach();
  const pending = desktopCommand(link.identity.id, { type: "ssh_discover_aliases" });
  await Bun.sleep(10);
  expect(frames[0]?.type).toBe("attached");
  expect(frames[1]?.type).toBe("command");
  link.close();
  await expect(pending).rejects.toThrow("disconnected");
  expect(parseDesktopCommand({ type: "service", verb: "stop" })).toBeNull();
  expect(parseDesktopCommand({ type: "list_dirs", path: "/" })).toBeNull();
});
test("discovery uses attached desktop RPC and cookie owner gate", async () => {
  const { link, frames } = await attach();
  const caller = {
    actor: "cookie" as const,
    userId: owner,
    isAdmin: false,
    principal: null,
    apiKeyId: null,
    subshellId: null,
  };
  const pending = sshDiscovery(caller, link.identity.id);
  await Bun.sleep(10);
  const frame = frames.find((frame) => frame.type === "command");
  if (!frame) throw new Error("Broker did not receive discovery.");
  expect(frame.command).toEqual({ type: "ssh_discover_aliases" });
  await link.message({
    type: "result",
    requestId: frame.requestId,
    ok: true,
    data: { aliases: ["my-host"], includeCycle: false, truncated: false },
  });
  expect(await pending).toEqual({ aliases: ["my-host"], includeCycle: false, truncated: false });
  await expect(sshDiscovery({ ...caller, userId: foreign, isAdmin: true }, link.identity.id)).rejects.toThrow();
});
test("cookie pairing API enforces foreign ownership and rejects cross-origin writes", async () => {
  const app = new Elysia().use(errorHandlerPlugin).use(sshRuntimeRoutes);
  const pair = await pairing();
  const response = await app.fetch(
    new Request("http://localhost/api/ssh-runtime/desktop-brokers", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${cookie}`,
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ name: "My laptop", id: pair.id }),
    }),
  );
  expect(response.status).toBe(403);
});

test("actual native CLI attaches without enrollment, discovers local aliases, drains on EOF, resumes privately and honors revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-broker-integration-"));
  const home = join(root, "home");
  const config = join(root, "config");
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host desktop-fixture\n  HostName 127.0.0.1\n", { mode: 0o600 });
  const server = new Elysia()
    .use(errorHandlerPlugin)
    .use(desktopBrokerWsPlugin)
    .listen({ port: 0, hostname: "127.0.0.1" });
  if (!server.server) throw new Error("Fixture failed to listen.");
  const origin = `http://127.0.0.1:${server.server.port}`;
  const pair = await pairing();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (resume: boolean) => {
    const child = Bun.spawn(
      [process.execPath, "src/main.ts", "ssh-broker", "--server", origin, ...(resume ? ["--broker-id", pair.id] : [])],
      {
        cwd: resolve(import.meta.dir, "../../../../../../node/agent"),
        env: { ...process.env, HOME: home, SUBSHELL_CONFIG_HOME: config },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(child);
    child.stdin.write(`${JSON.stringify(resume ? {} : { pairingToken: pair.pairingToken })}\n`);
    return child;
  };
  async function attached(child: ReturnType<typeof spawn>) {
    const reader = child.stdout.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("CLI attach timed out")), 10_000);
        }),
      ]);
      if (result.done) throw new Error(`CLI failed: ${await new Response(child.stderr).text()}`);
      const line = new TextDecoder().decode(result.value).trim();
      const value = JSON.parse(line);
      expect(value).toEqual({ type: "attached", id: pair.id, name: pair.name });
      expect(line).not.toContain("dsb_");
      expect(line).not.toContain("dsp_");
    } finally {
      if (timeout) clearTimeout(timeout);
      reader.releaseLock();
    }
  }
  try {
    const first = spawn(false);
    await attached(first);
    expect(await desktopCommand(pair.id, { type: "ssh_discover_aliases" })).toEqual({
      aliases: ["desktop-fixture"],
      includeCycle: false,
      truncated: false,
    });
    const credentialFile = readdirSync(join(config, "ssh-brokers"))[0];
    if (!credentialFile) throw new Error("Credential was not saved.");
    expect(statSync(join(config, "ssh-brokers", credentialFile)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(config, "ssh-brokers"))).toHaveLength(1);
    first.stdin.end();
    expect(await first.exited).toBe(0);
    expect(await desktopOwnerLive(pair.id, owner)).toBe(false);
    const second = spawn(true);
    await attached(second);
    await revokeDesktopBroker(owner, pair.id);
    expect(await second.exited).toBe(0);
    const third = spawn(true);
    third.stdin.end();
    expect(await third.exited).toBe(1);
  } finally {
    for (const child of children)
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("loss after open acknowledgement but before registration cannot create an active runtime", async () => {
  const pair = await pairing();
  const identity = await authenticateDesktopBroker(`Bearer ${pair.pairingToken}`);
  let link: DesktopLink | undefined;
  link = await attachDesktopBroker(identity, {
    close: () => {},
    send: (value) => {
      const frame = JSON.parse(value);
      if (frame.type !== "command" || frame.command.type !== "ssh_session_open") return;
      const ref = frame.command.ref;
      void (async () => {
        await link?.message({
          type: "result",
          requestId: frame.requestId,
          ok: true,
          data: {
            hello: {
              type: "hello",
              runtimeProtocol: SSH_RUNTIME_PROTOCOL,
              agentVersion: "1.5.0",
              os: "linux",
              arch: "x64",
              capabilities: [],
              homeDir: "/home/remote",
              dataDir: "/home/remote/.local/share/subshell/runtime",
              tmuxSocket: "subshell-ssh-ab12cd34ef56",
              paneCount: 0,
            },
            host: "127.0.0.1",
            port: 22,
            user: null,
          },
        });
        await link?.message({ type: "session_lost", ref });
      })();
    },
  });
  links.push(link);
  await expect(
    openSession(owner, {
      connectingNodeId: pair.id,
      target: { alias: "fixture", host: "127.0.0.1", port: 22, user: null, identityFile: null },
    }),
  ).rejects.toThrow("disconnected while opening");
  expect(
    await db.selectFrom("sshRuntimeSessions").select("id").where("connectingNodeId", "=", pair.id).execute(),
  ).toEqual([]);
});

test("live account disable removes broker authority before any command is enqueued", async () => {
  const { link, frames, identity } = await attach();
  await db.updateTable("userMeta").set({ disabled: 1 }).where("userId", "=", owner).execute();
  try {
    await expect(desktopCommand(link.identity.id, { type: "ssh_discover_aliases" })).rejects.toThrow("unavailable");
    expect(frames.filter((frame) => frame.type === "command")).toEqual([]);
    await expect(authenticateDesktopBroker(`Bearer ${identity.credential}`)).rejects.toThrow();
  } finally {
    await db.updateTable("userMeta").set({ disabled: 0 }).where("userId", "=", owner).execute();
  }
});

test("duplicate desktop names return actionable 409 and Pair again preserves the existing identity", async () => {
  const name = `Named desktop ${crypto.randomUUID().slice(0, 8)}`;
  const pair = await pairDesktopBroker(owner, { name });
  ids.push(pair.id);
  const app = new Elysia().use(errorHandlerPlugin).use(sshRuntimeRoutes);
  const response = await app.fetch(
    new Request("http://localhost/api/ssh-runtime/desktop-brokers", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${cookie}`,
        "content-type": "application/json",
        origin: "http://localhost:3080",
      },
      body: JSON.stringify({ name }),
    }),
  );
  expect(response.status).toBe(409);
  const duplicate = (await response.json()) as { message: string };
  expect(duplicate.message).toContain("Pair again");
  const again = await pairDesktopBroker(owner, { name, id: pair.id });
  expect(again.id).toBe(pair.id);
  expect(again.pairingToken).not.toBe(pair.pairingToken);
  await expect(authenticateDesktopBroker(`Bearer ${pair.pairingToken}`)).rejects.toThrow();
});

test("simultaneous adds with the same name map the database uniqueness race to 409", async () => {
  const name = `Racing desktop ${crypto.randomUUID().slice(0, 8)}`;
  const results = await Promise.allSettled([pairDesktopBroker(owner, { name }), pairDesktopBroker(owner, { name })]);
  const accepted = results.filter((result) => result.status === "fulfilled");
  expect(accepted).toHaveLength(1);
  for (const result of accepted) if (result.status === "fulfilled") ids.push(result.value.id);
  const refused = results.find((result) => result.status === "rejected");
  if (refused?.status !== "rejected") throw new Error("Duplicate add should refuse.");
  expect(refused.reason.status).toBe(409);
  expect(refused.reason.message).toContain("Pair again");
});
