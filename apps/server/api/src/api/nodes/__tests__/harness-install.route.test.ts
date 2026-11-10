import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authDatabase } from "@/modules/auth/database.js";
import {
  attachConnection,
  holdConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/modules/nodes/node-registry.js";
import { resolveResult } from "@/modules/nodes/node-rpc.js";
import { claimHarnessRun, HarnessRunRefused } from "@/modules/plugins/harness-run-lock.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * The refusals BEFORE the body opens are what this pins: they cannot become a
 * stream frame, so each has to be a real status, and the ORDER is the security
 * rule: the node's kind is answered before any grant is weighed, a plugin that
 * this build cannot install is a caller-input answer (404/400) whatever the
 * node's reachability, and a live socket is only demanded once there is
 * something to run. A successful run streams NDJSON, answered here over a fake
 * live socket; the run itself (`installHarnessOnNode`, its claim, and the
 * detection refresh) is covered by `harness-install.service.test.ts`. This file
 * never executes a vendor's installer.
 */

const pw = "harness-install-route-1";
const ownerEmail = `hi-owner-${crypto.randomUUID()}@subshell.local`;
const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
let ownerToken: string;
let ownerId: string;
let agentNode: string;
const adminEmail = `hi-admin-${crypto.randomUUID()}@subshell.local`;
let adminToken: string;
let bearerSubshellId = "";
let bearerKeyId: string | undefined;
let bearerKey = "";

/** POST the install route; a token authenticates, an omission does not. */
function post(nodeId: string, pluginId: string, token?: string) {
  const path = `/api/nodes/${nodeId}/harnesses/${pluginId}/install`;
  return app.fetch(
    token
      ? authedRequest(path, token, { method: "POST" })
      : new Request(`http://localhost:3080${path}`, { method: "POST" }),
  );
}

/** POST carrying a machine bearer instead of a browser cookie. */
function postBearer(nodeId: string, pluginId: string, key: string) {
  return app.fetch(
    new Request(`http://localhost:3080/api/nodes/${nodeId}/harnesses/${pluginId}/install`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    }),
  );
}

/** Create a member whose only relationship with the node is one grant row. */
async function grantee(): Promise<{ token: string; id: string; email: string }> {
  const email = `hi-grantee-${crypto.randomUUID()}@subshell.local`;
  const id = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  return { token: await signIn(email, pw), id, email };
}

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await new UsersRepository(db).createUser({
    email: ownerEmail,
    name: ownerEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  ownerToken = await signIn(ownerEmail, pw);
  await new UsersRepository(db).createUser({
    email: adminEmail,
    name: adminEmail,
    passwordHash: await hashPassword(pw),
    role: "admin",
  });
  adminToken = await signIn(adminEmail, pw);
  bearerSubshellId = `hi_s_${crypto.randomUUID().slice(0, 8)}`;
  await new SubshellsRepository(db).create({
    id: bearerSubshellId,
    userId: ownerId,
    presetId: "p",
    harnessId: "claude-code",
    name: bearerSubshellId,
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  bearerKey = await issueSubshellToken(bearerSubshellId, ownerId);
  bearerKeyId = (await new SubshellsRepository(db).findById(bearerSubshellId))?.apiKeyId ?? undefined;
  agentNode = crypto.randomUUID();
  // Offline on purpose: the live socket is demanded only after the plugin and
  // the grant have passed, so a 409 proves every earlier answer.
  await nodes.create({ id: agentNode, ownerUserId: ownerId, name: "hi-node", kind: "agent", status: "offline" });
});

afterAll(async () => {
  if (bearerSubshellId) await db.deleteFrom("subshells").where("id", "=", bearerSubshellId).execute();
  if (bearerKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [bearerKeyId]);
  await nodes.deleteById(agentNode);
  await deleteUserByEmailOrId(ownerEmail);
  await deleteUserByEmailOrId(adminEmail);
});

describe("POST /api/nodes/:id/harnesses/:pluginId/install refusals", () => {
  it("refuses a caller with no session", async () => {
    const res = await post(agentNode, "claude-code");
    expect(res.status).toBe(401);
  });

  it("refuses a machine bearer: installing software is a browser-session act", async () => {
    // A key is a machine credential, not a person pressing a button, even when
    // it carries `nodes:configure` for the node's owner.
    const res = await postBearer(agentNode, "claude-code", bearerKey);
    expect(res.status).toBe(403);
  });

  it("refuses the control-plane host: the setup route owns that install", async () => {
    // The server's own machine installs in-process through the admin setup
    // screen. Answering 400 here keeps one gate for that line rather than two.
    const res = await post("local", "claude-code", adminToken);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INPUT_VALIDATION_ERROR",
      message: expect.stringContaining("setup"),
    });
  });

  it("refuses a view grantee: installing follows the configure band", async () => {
    const user = await grantee();
    const shares = new NodeSharesRepository(db);
    try {
      await shares.replaceForNode(agentNode, [{ granteeUserId: user.id, permission: "view" }], ownerId);
      expect((await post(agentNode, "claude-code", user.token)).status).toBe(403);
    } finally {
      await shares.replaceForNode(agentNode, [], ownerId);
      await deleteUserByEmailOrId(user.email);
    }
  });

  it("lets edit, manage and admin-at-edit grantees reach the run", async () => {
    // The same band Update carries: `edit` already runs the installer line
    // through Update's fallback, so a narrower install gate would not keep it
    // out. The offline node answers 409, proving every earlier gate passed.
    const user = await grantee();
    const shares = new NodeSharesRepository(db);
    try {
      for (const permission of ["edit", "manage"] as const) {
        await shares.replaceForNode(agentNode, [{ granteeUserId: user.id, permission }], ownerId);
        expect((await post(agentNode, "claude-code", user.token)).status).toBe(409);
      }
      // The instance-wide admin boost ranks an agent at edit, which is now
      // enough for this route.
      await shares.replaceForNode(agentNode, [], ownerId);
      expect((await post(agentNode, "claude-code", adminToken)).status).toBe(409);
    } finally {
      await shares.replaceForNode(agentNode, [], ownerId);
      await deleteUserByEmailOrId(user.email);
    }
  });

  it("still lets a manage grantee reach the run", async () => {
    // The positive half of the gate, so a regression to owner-only fails here
    // rather than passing every refusal above.
    const user = await grantee();
    const shares = new NodeSharesRepository(db);
    try {
      await shares.replaceForNode(agentNode, [{ granteeUserId: user.id, permission: "manage" }], ownerId);
      expect((await post(agentNode, "claude-code", user.token)).status).toBe(409);
    } finally {
      await shares.replaceForNode(agentNode, [], ownerId);
      await deleteUserByEmailOrId(user.email);
    }
  });

  it("refuses an unknown plugin, a terminal, and an offline node in that order", async () => {
    expect((await post(agentNode, "not-a-plugin", ownerToken)).status).toBe(404);
    // A terminal drives no CLI: the manifest declares no installer, and that is
    // a caller-input answer whether or not the node is reachable.
    expect((await post(agentNode, "terminal", ownerToken)).status).toBe(400);
    const offline = await post(agentNode, "claude-code", ownerToken);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({ code: "NODE_OFFLINE" });
  });
});

describe("POST /api/nodes/:id/harnesses/:pluginId/install runs", () => {
  /** One signed frame's claims, the way the agent reads the envelope. */
  interface Claims {
    jti: string;
    cmd: { type: string; harnessId?: string };
  }

  /** Decode one signed frame's claims. */
  function claimsOf(frameJson: string): Claims {
    const { jws } = JSON.parse(frameJson) as { jws: string };
    return JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as Claims;
  }

  /**
   * A live socket that hands each frame to the test as it is sent, so an
   * answer lands on the real condition (a frame is on the wire) rather than a
   * sleep. `sent` keeps the raw frames for the assertion that nothing went out.
   */
  function liveSocket(): { socket: NodeSocket; sent: string[]; next: () => Promise<Claims> } {
    const sent: string[] = [];
    const queued: Claims[] = [];
    const waiting: ((claims: Claims) => void)[] = [];
    return {
      sent,
      socket: {
        send(data) {
          const raw = String(data);
          sent.push(raw);
          const claims = claimsOf(raw);
          const waiter = waiting.shift();
          if (waiter) waiter(claims);
          else queued.push(claims);
          return 0;
        },
        close() {},
      },
      next() {
        const ready = queued.shift();
        if (ready) return Promise.resolve(ready);
        const { promise, resolve } = Promise.withResolvers<Claims>();
        waiting.push(resolve);
        return promise;
      },
    };
  }

  it("answers 409 EXISTS when another harness run holds the node", async () => {
    // The slot is the node's, shared by install and update, and the refusal is
    // decided before the body opens: a racing press can only answer `error`
    // over a 200, and nothing has been signed yet either.
    const { socket, sent } = liveSocket();
    attachConnection(agentNode, socket);
    const held = claimHarnessRun(agentNode, "codex", "install");
    if (held instanceof HarnessRunRefused) throw new Error("the slot should be free when this test starts");
    try {
      const res = await post(agentNode, "claude-code", ownerToken);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "EXISTS_ERROR" });
      expect(sent).toHaveLength(0);
    } finally {
      held.release();
      resetNodeRegistryForTests();
    }
  });

  it("refuses a HELD socket: a held node predates the install command", async () => {
    // Held is projected offline, but the route must not fall back to it the
    // way the node-update route does: that socket speaks a protocol without
    // `harness_install`, so nothing may be signed over it.
    const { socket, sent } = liveSocket();
    const conn = attachConnection(agentNode, socket);
    holdConnection(agentNode, conn, {
      reason: "below-floor",
      agentVersion: "0.8.0",
      protocolVersion: 28,
      os: "linux",
      arch: "x64",
      onIdle: () => undefined,
    });
    try {
      const res = await post(agentNode, "claude-code", ownerToken);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "NODE_OFFLINE" });
      expect(sent).toHaveLength(0);
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("streams one terminal done frame carrying the run's parsed result", async () => {
    const { socket, next } = liveSocket();
    const conn = attachConnection(agentNode, socket);
    try {
      const resP = post(agentNode, "claude-code", ownerToken);
      const install = await next();
      expect(install.cmd.type).toBe("harness_install");
      expect(install.cmd.harnessId).toBe("claude-code");
      resolveResult(conn, {
        type: "result",
        ref: install.jti,
        ok: true,
        data: { harnessId: "claude-code", ok: true, exitCode: 0, output: "installed", durationMs: 5, timedOut: false },
      } as const);
      // A run that returned before its deadline refreshes detection, so it is
      // the second command on the wire; answer it so the stream can close.
      const detect = await next();
      expect(detect.cmd.type).toBe("detect");
      resolveResult(conn, {
        type: "result",
        ref: detect.jti,
        ok: true,
        data: { results: [], env: {} },
      } as const);

      const res = await resP;
      expect(res.status).toBe(200);
      const frames = (await res.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      const done = frames.filter((frame) => frame.type === "done");
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({
        harnessId: "claude-code",
        ok: true,
        exitCode: 0,
        output: "installed",
        durationMs: 5,
        timedOut: false,
      });
      expect(frames.filter((frame) => frame.type === "error")).toHaveLength(0);
    } finally {
      resetNodeRegistryForTests();
    }
  });
});
