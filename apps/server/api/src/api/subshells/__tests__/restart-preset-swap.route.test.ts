import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * The preset swap inside the restart route (spec 2026-09-23 §2).
 *
 * `POST /api/subshells/:id/restart` gained an optional body
 * `{ presetId: string | null }`: the column is written at the manager's swap
 * point (after the kill, before the parked re-read), so every refusal — the
 * gate's 403, the node's 409, the swap validator's 400 — must leave the row's
 * preset byte-identical, and a plain no-body restart must behave exactly as
 * before (that path is what the MCP `restart_subshell` tool and the SPA's
 * Restart item send).
 *
 * The fixtures are the cross-stack ones: a scripted agent (`test-helpers/
 * scripted-node.ts`) answers the real RemoteLauncher's RPCs, so a restart that
 * SUCCEEDS costs no tmux and the relaunched `launch` frame is readable off the
 * wire — which is how these tests see the swap reach the compose, not just
 * the column.
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
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, probeAllAlive, statDirEcho } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const presets = new PresetsRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/** The lifecycle a restart can trigger on the row's node (the Task-14 set). */
const LIFECYCLE = {
  stat_dir: statDirEcho,
  launch: ok,
  terminate: ok,
  kill: ok,
  input: ok,
  resize: ok,
  probe: probeAllAlive,
  prompt_deliver: () => ({ promptDelivered: true }),
  path_exists: () => ({ exists: true }),
  remove_paths: ok,
};

/** Narrowing helper: the launch variant of a captured command list (the integration suite's). */
type LaunchCmd = Extract<NodeCommandBody, { type: "launch" }>;

describe("preset swap inside POST /api/subshells/:id/restart (spec 2026-09-23)", () => {
  const ownerEmail = `swap-${crypto.randomUUID()}@subshell.local`;
  const granteeEmail = `swapg-${crypto.randomUUID()}@subshell.local`;
  const pw = "swaproute-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;

  let presetA: string; // owner's, claude-code, name "swap-src"  — the launch preset
  let presetB: string; // owner's, claude-code, name "swap-dst", env SWAPPED_BY — the swap target
  let presetOtherHarness: string; // owner's, terminal — wrong harness
  let presetForeign: string; // grantee's, claude-code — the caller's own for a view grantee

  let nodeLive: string; // agent node with a scripted agent attachable per test
  let nodeMaint: string; // agent node in maintenance — refused before the manager

  const createdSubshellIds: string[] = [];

  /** POST the restart route as a cookie principal; `body` omitted = a truly empty POST. */
  async function restart(id: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
    const headers = new Headers();
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
        method: "POST",
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
  }

  /** A running row on the scripted node, launched through the real create route with presetA. */
  async function createOnLive(name: string): Promise<string> {
    const res = await app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        body: JSON.stringify({
          harnessId: "claude-code",
          presetId: presetA,
          workingDir: "/srv/work/swap",
          nodeId: nodeLive,
          name,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    createdSubshellIds.push(body.id);
    return body.id;
  }

  const rowPreset = (id: string) => subshells.findById(id).then((r) => r?.presetId);
  async function audits(id: string): Promise<{ action: string; metadataJson: string | null }[]> {
    return db.selectFrom("auditEvents").where("targetId", "=", id).select(["action", "metadataJson"]).execute();
  }
  const errorBody = async (res: Response) => (await res.json()) as { code: string; message: string };

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    granteeId = await new UsersRepository(db).createUser({
      email: granteeEmail,
      name: granteeEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    granteeCookie = await signIn(granteeEmail, pw);

    presetA = await seedPreset(presets, { userId: ownerId, name: "swap-src" });
    presetB = await seedPreset(presets, {
      userId: ownerId,
      name: "swap-dst",
      envJson: JSON.stringify({ SWAPPED_BY: "test" }),
    });
    presetOtherHarness = await seedPreset(presets, { userId: ownerId, name: "swap-terminal", harnessId: "terminal" });
    presetForeign = await seedPreset(presets, { userId: granteeId, name: "swap-grantee" });

    nodeLive = crypto.randomUUID();
    await nodes.create({ id: nodeLive, ownerUserId: ownerId, name: `swap-${nodeLive.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      nodeLive,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    nodeMaint = crypto.randomUUID();
    await nodes.create({ id: nodeMaint, ownerUserId: ownerId, name: `swapm-${nodeMaint.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      nodeMaint,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    await nodes.setMaintenance(nodeMaint, {
      on: true,
      changedAt: new Date().toISOString(),
      source: "plane",
    });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const id of [nodeLive, nodeMaint]) await nodes.deleteById(id);
    for (const id of [presetA, presetB, presetOtherHarness, presetForeign]) {
      await db.deleteFrom("presets").where("id", "=", id).execute();
    }
    for (const email of [ownerEmail, granteeEmail]) await deleteUserByEmailOrId(email);
  });

  it("no-body, empty-ct and {} bodies all restart with the preset it has (the MCP path pinned)", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-plain");
      // Three shapes the pre-existing callers actually send: no body at all,
      // content-type set over an empty body (the shape the maintenance-route
      // helper posts), and an explicit {}.
      const plain = await restart(id, { cookie: ownerCookie });
      expect(plain.status).toBe(200);
      const withCt = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        }),
      );
      expect(withCt.status).toBe(200);
      const emptyObj = await restart(id, { cookie: ownerCookie, body: {} });
      expect(emptyObj.status).toBe(200);
      expect(await rowPreset(id)).toBe(presetA); // byte-identical through all three
      expect(sim.countOf("kill")).toBe(3); // all three actually restarted it
    } finally {
      sim.detach();
    }
  });

  it("swap to the caller's same-harness preset: column, relaunched frame, and BOTH audit rows", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-to-b");
      const res = await restart(id, { cookie: ownerCookie, body: { presetId: presetB } });
      expect(res.status).toBe(200);
      expect(await rowPreset(id)).toBe(presetB);

      // The swap reaches the compose, not just the column: the relaunched
      // frame carries the NEW preset (name + env) to the node (spec §5).
      const relaunch = sim.cmdsOf("launch")[1] as LaunchCmd;
      expect(relaunch.preset.name).toBe("swap-dst");
      expect(relaunch.preset.env.SWAPPED_BY).toBe("test");

      const rows = await audits(id);
      const switchRow = rows.find((r) => r.action === "subshell.preset_switch");
      expect(JSON.parse(switchRow?.metadataJson ?? "null")).toEqual({ name: "swap-to-b", presetId: presetB });
      expect(rows.some((r) => r.action === "subshell.restart")).toBe(true);
    } finally {
      sim.detach();
    }
  });

  it("swap to null clears the column and records null in the audit metadata", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-to-null");
      const res = await restart(id, { cookie: ownerCookie, body: { presetId: null } });
      expect(res.status).toBe(200);
      expect(await rowPreset(id)).toBeNull();
      const rows = await audits(id);
      const switchRow = rows.find((r) => r.action === "subshell.preset_switch");
      expect(JSON.parse(switchRow?.metadataJson ?? "undefined")).toEqual({ name: "swap-to-null", presetId: null });
      expect(rows.some((r) => r.action === "subshell.restart")).toBe(true);
    } finally {
      sim.detach();
    }
  });

  it("unknown, foreign, and wrong-harness targets all 400 INVALID_PRESET and restart nothing", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-refuse");
      for (const bad of ["no-such-preset-id", presetForeign, presetOtherHarness]) {
        const res = await restart(id, { cookie: ownerCookie, body: { presetId: bad } });
        expect(res.status).toBe(400);
        expect((await errorBody(res)).code).toBe("INVALID_PRESET");
        expect(await rowPreset(id)).toBe(presetA); // untouched by every refusal
      }
      expect(sim.countOf("kill")).toBe(0); // nothing was even attempted
      expect(sim.cmdTypes()).toEqual(["stat_dir", "launch"]); // the create pair only
    } finally {
      sim.detach();
    }
  });

  it("a view grantee is refused by the gate, with or without the body, preset untouched", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-viewer");
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "view" }], ownerId);
      // The same refusal the no-body restart gives — and the body names a
      // preset that WOULD validate for this caller, so a 400 here would mean
      // the swap check ran before the gate.
      expect((await restart(id, { cookie: granteeCookie })).status).toBe(403);
      expect((await restart(id, { cookie: granteeCookie, body: { presetId: presetForeign } })).status).toBe(403);
      expect(await rowPreset(id)).toBe(presetA);
      expect(sim.countOf("kill")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("swapping to the SAME preset is just a restart: no preset_switch row", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-same");
      const res = await restart(id, { cookie: ownerCookie, body: { presetId: presetA } });
      expect(res.status).toBe(200);
      expect(await rowPreset(id)).toBe(presetA);
      const rows = await audits(id);
      expect(rows.some((r) => r.action === "subshell.restart")).toBe(true);
      expect(rows.some((r) => r.action === "subshell.preset_switch")).toBe(false);
    } finally {
      sim.detach();
    }
  });

  it("a bearer restart with no body still works through requirePerm (the MCP tool's path)", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    try {
      const id = await createOnLive("swap-bearer");
      const key = await issueSubshellToken(id, ownerId);
      const res = await restart(id, { bearer: key });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, promptDelivered: false });
      expect(await rowPreset(id)).toBe(presetA);
      expect(sim.countOf("kill")).toBe(1);
    } finally {
      sim.detach();
    }
  });

  it("the maintenance 409 outranks the swap validation and leaves the preset byte-identical", async () => {
    // Direct row: the node refuses launches, so no create route. The refusal
    // happens in the SERVICE before the manager is entered at all — the
    // ordering (spec §2: validation after every 409) is what this pins.
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await subshells.create({
      id,
      userId: ownerId,
      presetId: presetA,
      harnessId: "claude-code",
      name: "swap-maint",
      workingDir: "/tmp",
      tmuxSocket: `swap-sock-${id}`,
      nodeId: nodeMaint,
      alive: 0,
    });
    const res = await restart(id, { cookie: ownerCookie, body: { presetId: presetB } });
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("NODE_IN_MAINTENANCE");
    expect(await rowPreset(id)).toBe(presetA);
  });

  it("an offline node 409s with the preset untouched (the kill precedes the swap point)", async () => {
    const sim = attachScriptedNode(nodeLive, LIFECYCLE);
    const id = await createOnLive("swap-offline");
    sim.detach(); // the row is alive=1 with no connection: the kill fires first and fails
    const res = await restart(id, { cookie: ownerCookie, body: { presetId: presetB } });
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("NODE_OFFLINE");
    expect(await rowPreset(id)).toBe(presetA);
  });
});
