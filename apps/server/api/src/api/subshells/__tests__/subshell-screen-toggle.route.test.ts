/**
 * The live display toggle (spec 2026-11-06). PUT /:id/screen writes the row's
 * desired screen and rides the existing restart to apply it: a refusal
 * anywhere leaves screen_config exactly as it was. The "already has a display"
 * refusal fires only while the plane believes a display is live for the pane
 * (the broker memory `/views` answers `screen` from), so a dead row that kept
 * its config or a display the node reported lost heals through the same PUT.
 * DELETE clears the column
 * FIRST (desired-state-first) and then sends preview_display_close, always, so
 * a repeated off converges even after a mid-flight failure. Both flips refuse
 * while the node is offline, at edit access, and an ssh pane refuses like
 * restart refuses. A foreign row is 404; the composed anonymous rejection is
 * owned by api-surface-auth.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/testing/api/auth-tables.js";
import { attachScriptedNode, ok, probeAllAlive, type ScriptedHandlers, statDirEcho } from "@/testing/scripted-node.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);
const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/**
 * The lifecycle the toggle's restart triggers on the scripted node, copied
 * from restart-prompt.route.test.ts's lifecycle() map verbatim (that map is
 * the set the restart path actually sends; unscripted traffic fails loudly),
 * plus the one new arm the off-flip sends.
 */
function toggleHandlers(): ScriptedHandlers {
  return {
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
    preview_display_close: () => ({ closed: true }),
  };
}

const pw = "toggle-pass-1";
const ownerEmail = `tgl-owner-${randomUUID()}@subshell.local`;
const viewerEmail = `tgl-viewer-${randomUUID()}@subshell.local`;
const strangerEmail = `tgl-str-${randomUUID()}@subshell.local`;
let ownerId: string;
let viewerId: string;
let ownerCookie: string;
let viewerCookie: string;
let strangerCookie: string;
let agentNode: string; // virtualDisplayEnabled 1
let offNode: string; // the same, with the node's display switch off
const created: string[] = [];

async function putScreen(id: string, cookie: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/screen`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
      body: JSON.stringify(body),
    }),
  );
}
async function deleteScreen(id: string, cookie: string) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/screen`, {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${cookie}` },
    }),
  );
}

/** One fresh dead row per case (no cross-test row reuse). */
async function seedPane(tag: string, nodeId: string): Promise<string> {
  const id = randomUUID();
  created.push(id);
  await subshells.create({
    id,
    userId: ownerId,
    harnessId: "claude-code",
    name: `toggle-${tag}`,
    workingDir: tmpdir(),
    tmuxSocket: null,
    status: "terminated",
    alive: 0,
    nodeId,
  });
  return id;
}

beforeAll(async () => {
  await setupAuthTables();
  resetNodeRegistryForTests();
  await ensureLocalNode(db);
  const users = new UsersRepository(db);
  const mk = async (email: string) =>
    await users.createUser({ email, name: email, passwordHash: await hashPassword(pw), role: "user" });
  ownerId = await mk(ownerEmail);
  viewerId = await mk(viewerEmail);
  await mk(strangerEmail);
  ownerCookie = await signIn(ownerEmail, pw);
  viewerCookie = await signIn(viewerEmail, pw);
  strangerCookie = await signIn(strangerEmail, pw);

  agentNode = randomUUID();
  await nodes.create({
    id: agentNode,
    ownerUserId: ownerId,
    name: `toggle-${agentNode.slice(0, 8)}`,
    kind: "agent",
    virtualDisplayEnabled: 1,
  });
  await nodes.applyInventory(
    agentNode,
    JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
  );
  offNode = randomUUID();
  await nodes.create({
    id: offNode,
    ownerUserId: ownerId,
    name: `toggle-off-${offNode.slice(0, 8)}`,
    kind: "agent",
    virtualDisplayEnabled: 0,
  });
  await nodes.applyInventory(
    offNode,
    JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
  );
});

afterAll(async () => {
  resetNodeRegistryForTests();
  for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
  for (const id of [agentNode, offNode]) await nodes.deleteById(id);
  for (const email of [ownerEmail, viewerEmail, strangerEmail]) await deleteUserByEmailOrId(email);
});

describe("PUT /api/subshells/:id/screen", () => {
  it("sets the desired screen and rides the restart: 200, provider pinned on the row, the node sees the screen", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("on", agentNode);
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { screen: unknown };
    expect(body.screen).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" }); // the node default
    const row = await subshells.findById(id);
    expect(JSON.parse(row!.screenConfig!)).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" });
    expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" });
    sim.detach();
  });

  it("a dead pane that kept its display config heals: the PUT proceeds and restarts", async () => {
    // The dup guard reads LIVE state, not the desired column: a row nothing
    // fed into the broker's display memory for reads OFF in the picker, so
    // its enable must write the fresh request and restart, not 409 at an
    // unreachable "turn it off first".
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("dup-dead", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
    expect(res.status).toBe(200);
    expect(JSON.parse((await subshells.findById(id))!.screenConfig!)).toEqual({
      width: 1024,
      height: 768,
      provider: "xvfb-x11vnc",
    });
    expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual({ width: 1024, height: 768, provider: "xvfb-x11vnc" });
    sim.detach();
  });

  it("a pane with a live display refuses the second enable: 409, no restart, column unchanged", async () => {
    // Live state is driven the way the feature itself produces it: the
    // scripted node's launch ack names the display it allocated, which feeds
    // the plane's broker memory (remote-launcher's onDisplayOpened). The row
    // is now running with a remembered screen, and a second PUT is the
    // checked-box case the spec keeps as a refusal.
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => ({ screen: { display: ":97", viewer: { protocol: "vnc", port: 5997 } } }),
    });
    const id = await seedPane("dup-live", agentNode);
    const first = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(first.status).toBe(200);
    const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("Turn it off first");
    expect((await subshells.findById(id))!.screenConfig).toContain("640");
    expect(sim.countOf("launch")).toBe(1); // the 409 restarted nothing
    sim.detach();
  });

  it("the node switch off refuses with the node's own word and writes nothing", async () => {
    const sim = attachScriptedNode(offNode, toggleHandlers());
    const id = await seedPane("switchoff", offNode);
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("(preview-node-off)");
    expect((await subshells.findById(id))!.screenConfig).toBeNull(); // the spec's crux: refusal wrote nothing
    sim.detach();
  });

  it("an oversize width is refused at the schema before anything reads the row", async () => {
    const id = await seedPane("huge", agentNode);
    const res = await putScreen(id, ownerCookie, { width: 4097, height: 800 });
    expect(res.status).toBe(400);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });

  it("a view grantee is 403 and a stranger is 404, both leaving the row untouched", async () => {
    const id = await seedPane("access", agentNode);
    await shares.replaceForSubshell(id, [{ granteeUserId: viewerId, permission: "view" }], ownerId);
    expect((await putScreen(id, viewerCookie, { width: 640, height: 480 })).status).toBe(403);
    expect((await putScreen(id, strangerCookie, { width: 640, height: 480 })).status).toBe(404);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });

  it("an offline node refuses before the clear: 409 and no write", async () => {
    const id = await seedPane("offline", agentNode);
    // No attach at all: isNodeOffline reads the registry empty.
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });

  it("an ssh pane refuses both flips with the restart refusal (decision 7 carried over)", async () => {
    const id = randomUUID();
    created.push(id);
    await subshells.create({
      id,
      userId: ownerId,
      harnessId: "ssh",
      name: "toggle-ssh",
      workingDir: tmpdir(),
      tmuxSocket: null,
      status: "terminated",
      alive: 0,
      nodeId: agentNode,
      ssh: '{"host":"example.test"}',
    });
    const put = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(put.status).toBe(409);
    expect(((await put.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_NO_RESTART);
    expect((await deleteScreen(id, ownerCookie)).status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });
});

describe("DELETE /api/subshells/:id/screen", () => {
  it("clears the desired state first and sends the close the pane owns", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("off", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { closed: boolean }).closed).toBe(true); // the scripted answer
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
    expect(sim.cmdsOf("preview_display_close")).toEqual([{ type: "preview_display_close", paneId: id }]);
    sim.detach();
  });

  it("with nothing allocated it is still a 200 and still sends the close (repeat-off converges)", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("none", agentNode);
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(200);
    expect(sim.cmdsOf("preview_display_close").length).toBe(1);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
    sim.detach();
  });

  it("an offline node refuses BEFORE the clear: the saved wish survives", async () => {
    const id = await seedPane("off-offline", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toContain("800");
  });

  it("a view grantee is 403 and a stranger is 404, config intact", async () => {
    const id = await seedPane("off-access", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    await shares.replaceForSubshell(id, [{ granteeUserId: viewerId, permission: "view" }], ownerId);
    expect((await deleteScreen(id, viewerCookie)).status).toBe(403);
    expect((await deleteScreen(id, strangerCookie)).status).toBe(404);
    expect((await subshells.findById(id))!.screenConfig).toContain("800");
  });
});
