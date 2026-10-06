import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The runtime seal at the HTTP surface (design 2026-10-05 §4, review M4):
 * ordinary create and restart must refuse a `runtime`-kind node BY NAME.
 *
 * The invariant this pins is the load-bearing one the whole callback design
 * rests on: "the token never leaves the plane". Today the accident that keeps
 * plain launches off runtime rows is `RuntimeSessionLauncher.resolveBinary`
 * answering null; the seal replaces the accident with the rule, so the day a
 * later workstream gives that launcher a resolver, the bearer token and the
 * plane URL baked into the launch env CANNOT ride onto a destination that must
 * never learn either. A restart is a launch, so the same refusal stands on
 * that door too - replacing what used to be the honest-but-useless "Harness is
 * not installed on this machine" from a pane that can never be restarted.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);
const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

const pw = "rtseal-pass-1";
const email = `rtseal-${crypto.randomUUID()}@subshell.local`;
let userId: string;
let cookie: string;
const nodeIds: string[] = [];
const subshellIds: string[] = [];

async function mkRuntimeNode(): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId: userId, name: `rs-${id.slice(0, 8)}`, kind: NODE_KIND_RUNTIME });
  return id;
}

async function mkPaneOn(nodeId: string): Promise<string> {
  const id = crypto.randomUUID();
  subshellIds.push(id);
  await subshells.create({
    id,
    userId,
    presetId: null,
    harnessId: "terminal",
    name: `rs-${id.slice(0, 8)}`,
    workingDir: "/tmp",
    tmuxSocket: `rs-sock-${id}`,
    nodeId,
    alive: 0,
  });
  return id;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost:3080${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

beforeAll(async () => {
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  cookie = await signIn(email, pw);
});

afterAll(async () => {
  for (const id of subshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
  for (const id of nodeIds) await nodes.deleteById(id);
  await deleteUserByEmailOrId(email);
});

describe("the runtime seal on /api/subshells (review M4)", () => {
  it("create naming a runtime row → 409, the refusal NAMES the runtime path", async () => {
    const runtime = await mkRuntimeNode();
    const res = await post("/api/subshells", { harnessId: "terminal", workingDir: "/tmp", nodeId: runtime });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Runtime sessions launch through the SSH runtime path only");
  });

  it("restart of a pane whose node is a runtime row → 409 naming the seal, never the resolveBinary accident", async () => {
    const runtime = await mkRuntimeNode();
    const id = await mkPaneOn(runtime);
    const res = await post(`/api/subshells/${id}/restart`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Runtime sessions launch through the SSH runtime path only");
    // The accident this replaces: the harness word must never be the answer.
    expect(body.message).not.toMatch(/not installed/i);
  });
});
