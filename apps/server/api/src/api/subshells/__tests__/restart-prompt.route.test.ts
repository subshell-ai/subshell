import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * The optional `prompt` riding a restart (spec 2026-09-25 MCP DX): the MCP
 * `restart_subshell` tool gains a first task to type, and this is the door it
 * posts through. `POST /api/subshells/:id/restart` keeps its byte-identical
 * body-less shape (the SPA and the tool's current calls), and a prompt, when
 * given, is delivered AFTER a successful revive through the SAME
 * `NodeLauncher.deliverPrompt` seam create uses, with the same settle
 * constants (15 s budget, 400 ms poll), so a remote agent runs the whole
 * settle loop as one `prompt_deliver` round-trip.
 *
 * Refusals type nothing: a 403 at the gate, or a 409 offline/in-flight, never
 * reaches a pane. And the response's `promptDelivered` (the field restart has
 * always carried as a truthful false) turns honest: true when a prompt was
 * asked for and typed, false when none was asked, when it was blank, or when
 * the pane never settled.
 *
 * Same cross-stack fixture as `restart-preset-swap.route.test.ts`: a scripted
 * agent answers the real RemoteLauncher, so a successful restart costs no tmux
 * and the `prompt_deliver` frame is readable off the wire.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import {
  attachScriptedNode,
  ok,
  probeAllAlive,
  type ScriptedHandlers,
  statDirEcho,
} from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/** The lifecycle a restart triggers on the scripted node, plus the prompt answer. */
function lifecycle(promptDelivered: boolean): ScriptedHandlers {
  return {
    stat_dir: statDirEcho,
    launch: ok,
    terminate: ok,
    kill: ok,
    input: ok,
    resize: ok,
    probe: probeAllAlive,
    prompt_deliver: () => ({ promptDelivered }),
    path_exists: () => ({ exists: true }),
    remove_paths: ok,
  };
}

describe("prompt inside POST /api/subshells/:id/restart (spec 2026-09-25)", () => {
  const ownerEmail = `rp-owner-${crypto.randomUUID()}@subshell.local`;
  const granteeEmail = `rp-viewer-${crypto.randomUUID()}@subshell.local`;
  const pw = "rpprompt-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;

  let presetId: string;
  let node: string;
  const createdSubshellIds: string[] = [];

  async function restart(id: string, opts: { cookie?: string; body?: unknown } = {}) {
    const headers = new Headers();
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
        method: "POST",
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
  }

  async function createRunning(name: string): Promise<string> {
    const res = await app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        body: JSON.stringify({
          harnessId: "claude-code",
          presetId,
          workingDir: "/srv/work/rp",
          nodeId: node,
          name,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    createdSubshellIds.push(body.id);
    return body.id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    granteeId = await users.createUser({
      email: granteeEmail,
      name: granteeEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    granteeCookie = await signIn(granteeEmail, pw);

    presetId = await seedPreset(new PresetsRepository(db), { userId: ownerId, name: "rp-src" });
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `rp-${node.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      node,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    for (const email of [ownerEmail, granteeEmail]) await deleteUserByEmailOrId(email);
  });

  it("a prompt rides a successful revive: one prompt_deliver frame, promptDelivered true", async () => {
    const sim = attachScriptedNode(node, lifecycle(true));
    try {
      const id = await createRunning("rp-deliver");
      const res = await restart(id, { cookie: ownerCookie, body: { prompt: "carry on the audit" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, promptDelivered: true });

      // A real restart happened first (kill + relaunch), THEN the settle seam.
      expect(sim.countOf("kill")).toBe(1);
      const frames = sim.cmdsOf("prompt_deliver");
      expect(frames.length).toBe(1);
      expect(frames[0]?.text).toBe("carry on the audit");
      expect(frames[0]?.subshellId).toBe(id);
      // The create flow's own constants, not a restart-chosen second set.
      expect(frames[0]?.settleTimeoutMs).toBe(15_000);
      expect(frames[0]?.pollMs).toBe(400);
    } finally {
      sim.detach();
    }
  });

  it("the pane never settles: the restart still succeeds and answers promptDelivered false", async () => {
    const sim = attachScriptedNode(node, lifecycle(false));
    try {
      const id = await createRunning("rp-unsure");
      const res = await restart(id, { cookie: ownerCookie, body: { prompt: "typed blind?" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ promptDelivered: false });
    } finally {
      sim.detach();
    }
  });

  it("a blank prompt asks the pane for nothing: no frame, flag false", async () => {
    const sim = attachScriptedNode(node, lifecycle(true));
    try {
      const id = await createRunning("rp-blank");
      const res = await restart(id, { cookie: ownerCookie, body: { prompt: "   " } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ promptDelivered: false });
      expect(sim.countOf("prompt_deliver")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("a plain restart stays byte-identical: no prompt_deliver, flag false", async () => {
    const sim = attachScriptedNode(node, lifecycle(true));
    try {
      const id = await createRunning("rp-plain");
      for (const body of [undefined, {}]) {
        const res = await restart(id, { cookie: ownerCookie, ...(body === undefined ? {} : { body }) });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ promptDelivered: false });
      }
      expect(sim.countOf("kill")).toBe(2);
      expect(sim.countOf("prompt_deliver")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("a refused restart types nothing: the view grantee's prompt dies at the gate", async () => {
    const sim = attachScriptedNode(node, lifecycle(true));
    try {
      const id = await createRunning("rp-refused");
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "view" }], ownerId);
      const res = await restart(id, { cookie: granteeCookie, body: { prompt: "may not type" } });
      expect(res.status).toBe(403);
      expect(sim.countOf("prompt_deliver")).toBe(0);
      expect(sim.countOf("kill")).toBe(0);
      expect((await subshells.findById(id))?.status).toBe("running");
    } finally {
      sim.detach();
    }
  });
});
