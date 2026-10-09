import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";

/**
 * `POST /api/ssh/setup-here` - the HTTP surface of the destination upgrade
 * (spec 2026-10-08 §7, Task 14). The act itself - re-open, exec, redaction,
 * the bounded `ready` wait - is pinned by `ssh-setup-here.service.test.ts`
 * against the real RPC chain; this file owns the doors in front of it: the
 * surface is browser sessions only (the launcher family's posture), a body
 * that is not a pane id is a 400, and a foreign pane is the 404 the
 * ownership axis demands, identical to an absent one.
 */

const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);
const port = "api/ssh/setup-here" as const;

function post(body: unknown, opts: { cookie?: string; bearer?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return app.fetch(
    new Request(`http://localhost:3099/${port}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

const pw = "setup-route-1";
const ownerEmail = `sh-route-o-${crypto.randomUUID()}@subshell.local`;
const otherEmail = `sh-route-x-${crypto.randomUUID()}@subshell.local`;
let owner = "";
let _other = "";
let ownerCookie = "";
let otherCookie = "";
const createdPanes: string[] = [];

async function mkPane(userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await new SubshellsRepository(db).create({
    id,
    userId,
    harnessId: "terminal",
    name: `route-probe-${id.slice(0, 8)}`,
    workingDir: "/tmp",
    tmuxSocket: null,
    nodeId: LOCAL_NODE_ID,
  });
  createdPanes.push(id);
  return id;
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  owner = await new UsersRepository(db).createUser({
    email: ownerEmail,
    name: ownerEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  _other = await new UsersRepository(db).createUser({
    email: otherEmail,
    name: otherEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  ownerCookie = await signIn(ownerEmail, pw);
  otherCookie = await signIn(otherEmail, pw);
  await ensureLocalNode(db);
});

afterAll(async () => {
  for (const id of createdPanes) await new SubshellsRepository(db).delete(id).catch(() => {});
  await new NodesRepository(db).deleteById(LOCAL_NODE_ID).catch(() => {});
  await deleteUserByEmailOrId(ownerEmail).catch(() => {});
  await deleteUserByEmailOrId(otherEmail).catch(() => {});
});

describe("POST /api/ssh/setup-here doors", () => {
  it("an empty cookie is a failed authentication (401), like every launcher door", async () => {
    expect((await post({ paneId: "whatever" }, { cookie: "" })).status).toBe(401);
  });

  it("bearer credentials are refused at the door: this surface is browser sessions only", async () => {
    const paneId = await mkPane(owner);
    const key = await issueSubshellToken(paneId, owner);
    const res = await post({ paneId }, { bearer: key });
    expect(res.status).toBe(403);
  });

  it("a body without a pane id is a 400 INPUT_VALIDATION_ERROR, not a service call", async () => {
    const res = await post({}, { cookie: ownerCookie });
    expect(res.status).toBe(400);
  });

  it("a foreign pane and an absent pane are one 404 (the ordinary invisibility)", async () => {
    const paneId = await mkPane(owner);
    const foreign = await post({ paneId }, { cookie: otherCookie });
    expect(foreign.status).toBe(404);
    const absent = await post({ paneId: crypto.randomUUID() }, { cookie: ownerCookie });
    expect(absent.status).toBe(404);
  });

  it("a non-ssh pane refuses by name through the service's own door", async () => {
    const paneId = await mkPane(owner);
    const res = await post({ paneId }, { cookie: ownerCookie });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.message).toContain("SSH-terminal pane");
  });
});
