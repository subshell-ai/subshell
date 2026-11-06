/**
 * The live display toggle (spec 2026-11-06). PUT /:id/screen writes the row's
 * desired screen and rides the existing restart to apply it: a refusal
 * anywhere leaves screen_config exactly as it was. The "already has a display"
 * refusal fires only while a display is live for the pane by the SAME
 * predicate `/views` answers `screen` through (`liveScreenForPane`: the ports
 * answer, filled by plane memory only while the node names no lost screen),
 * so a dead row that kept its config or a display the node reported lost
 * heals through the same PUT, an offline node answers the offline sentence
 * before the guard reads anything, and policy refusals (the node's display
 * switch, provider state) answer first too: a picker `/views` masks OFF
 * never hears the duplicate sentence. DELETE clears the column
 * FIRST (desired-state-first) and then sends preview_display_close, always, so
 * a repeated off converges even after a mid-flight failure, and a mid-flight
 * failure names WHICH failure it was (dropped link, silence, missing support,
 * or the node's own refusal). A closed display drops its ports-cache entry, so
 * the follow-up `/views` reads OFF without waiting out the 5 s window, and the
 * close audit names the acting viewer. Both flips refuse
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
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/testing/api/auth-tables.js";
import { attachScriptedNode, restartLifecycleHandlers, type ScriptedHandlers } from "@/testing/scripted-node.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);
const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/**
 * The restart lifecycle comes from the shared fixture factory (the same map
 * restart-prompt.route.test.ts runs), plus the off-flip's own arm; `extra`
 * layers the per-case answers (a launch ack, the ports scan, a refusal) that
 * a real node gives alongside.
 */
function toggleHandlers(extra: ScriptedHandlers = {}): ScriptedHandlers {
  return {
    ...restartLifecycleHandlers(),
    preview_display_close: () => ({ closed: true }),
    ...extra,
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
async function getViews(id: string, cookie: string) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/views`, {
      headers: { cookie: `better-auth.session_token=${cookie}` },
    }),
  );
}

async function postRestart(id: string, cookie: string) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
      body: "{}",
    }),
  );
}

/** Poll `cond` on the scripted node's wire, failing loudly rather than racing. */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Bun.sleep(10);
  }
  throw new Error(`waitUntil: ${what} never happened`);
}

/** A display the scripted node allocates and reports, as a real node answers. */
function screenAnswer(display: string, port: number) {
  return { display, viewer: { protocol: "vnc", port } };
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
    try {
      const id = await seedPane("on", agentNode);
      const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { screen: unknown };
      expect(body.screen).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" }); // the node default
      const row = await subshells.findById(id);
      expect(JSON.parse(row!.screenConfig!)).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" });
      expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" });
    } finally {
      sim.detach();
    }
  });

  it("a dead pane that kept its display config heals: the PUT proceeds and restarts", async () => {
    // The dup guard reads LIVE state, not the desired column: a row nothing
    // fed into the broker's display memory for reads OFF in the picker, so
    // its enable must write the fresh request and restart, not 409 at an
    // unreachable "turn it off first".
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    try {
      const id = await seedPane("dup-dead", agentNode);
      await subshells.update(id, {
        screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }),
      });
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.status).toBe(200);
      expect(JSON.parse((await subshells.findById(id))!.screenConfig!)).toEqual({
        width: 1024,
        height: 768,
        provider: "xvfb-x11vnc",
      });
      expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual({ width: 1024, height: 768, provider: "xvfb-x11vnc" });
    } finally {
      sim.detach();
    }
  });

  it("a pane with a live display refuses the second enable: 409, no restart, column unchanged", async () => {
    // Live state is driven the way the feature itself produces it: the
    // scripted node's launch ack names the display it allocated (feeding the
    // plane's broker memory via remote-launcher's onDisplayOpened), and its
    // ports scan reports the same screen, as a real node's does once its own
    // walk has run. The guard now asks the ports answer first, exactly like
    // `/views` renders it, so a second PUT is the checked-box case the spec
    // keeps as a refusal.
    const screen = screenAnswer(":97", 5997);
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => ({ screen }),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen }),
    });
    const id = await seedPane("dup-live", agentNode);
    try {
      const first = await putScreen(id, ownerCookie, { width: 640, height: 480 });
      expect(first.status).toBe(200);
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toContain("Turn it off first");
      expect((await subshells.findById(id))!.screenConfig).toContain("640");
      expect(sim.countOf("launch")).toBe(1); // the 409 restarted nothing
    } finally {
      sim.detach();
    }
  });

  it("a running pane whose close was REFUSED (live display, null config) still refuses a second enable", async () => {
    // The state a refused OFF leaves behind is reachable by design: the column
    // is cleared, the node kept the display. The guard asks live state whenever
    // the pane runs, not only when a config survives, because an enable over
    // that veteran display would reuse it and echo the new size as applied.
    const screen = screenAnswer(":91", 5991);
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen }),
    });
    const id = await seedPane("dup-nullconfig", agentNode);
    try {
      await subshells.update(id, { status: "running", alive: 1 }); // nothing ever wrote a config
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toContain("already has a virtual display");
      expect((await subshells.findById(id))!.screenConfig).toBeNull();
      expect(sim.countOf("launch")).toBe(0); // and restarted nothing
    } finally {
      sim.detach();
    }
  });

  it("the node's switch off answers a masked-OFF picker's enable with the node-off sentence, not the duplicate one", async () => {
    // The switch-off mask divergence (final review): `/views` masks `screen`
    // by the node's switch, so when an owner turns it off while the plane
    // still holds the pane's display live, the picker reads OFF and an
    // enable's honest cause is the switch. The resolver answers policy
    // BEFORE the duplicate guard reads live state, so the node-off sentence
    // wins and the row keeps what it had.
    const screen = screenAnswer(":96", 5996);
    const setSwitch = (on: number) =>
      db.updateTable("nodes").set({ virtualDisplayEnabled: on }).where("id", "=", offNode).execute();
    await setSwitch(1); // the owner has not noticed the switch yet
    const sim = attachScriptedNode(offNode, {
      ...toggleHandlers(),
      launch: () => ({ screen }),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen }),
    });
    try {
      const id = await seedPane("off-masked", offNode);
      expect((await putScreen(id, ownerCookie, { width: 640, height: 480 })).status).toBe(200); // live, remembered
      await setSwitch(0); // the display is still up when the owner flips it off
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.status).toBe(409);
      const message = ((await res.json()) as { message: string }).message;
      expect(message).toContain("(preview-node-off)");
      expect(message).not.toContain("already has a virtual display");
      expect((await subshells.findById(id))!.screenConfig).toContain("640"); // the refusal changed nothing
      expect(sim.countOf("launch")).toBe(1); // and restarted nothing
    } finally {
      sim.detach();
      await setSwitch(0); // leave the fixture as beforeAll made it
    }
  });

  it("regression pin: a display the node reported lost heals, even while the plane still remembers it", async () => {
    // The M5 finding, pinned: `/views` reads the pane OFF as soon as the node
    // reports `screenLost` (the death outranks the plane's memory), so an
    // enable whose duplicate guard still read raw memory was a 409 with an
    // unreachable remedy from an unchecked box. Guard and read are one
    // predicate now: the PUT proceeds and the restart reallocates.
    const screen = screenAnswer(":95", 5995);
    let reportedLost = false;
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => ({ screen }),
      preview_ports_get: () =>
        reportedLost
          ? { ports: [], cdpPort: null, screen: null, screenLost: "xvfb exited since the pane launched" }
          : { ports: [], cdpPort: null, screen },
    });
    const id = await seedPane("lost-heal", agentNode);
    try {
      expect((await putScreen(id, ownerCookie, { width: 640, height: 480 })).status).toBe(200); // ack feeds memory
      reportedLost = true; // the node's walk finds the dead provider...
      const views = (await (await getViews(id, ownerCookie)).json()) as { screen: unknown; screenLost?: string };
      expect(views.screen).toBeNull(); // ...and `/views` reads the pane OFF, the death outranking memory
      expect(views.screenLost).toBeDefined();
      // ...and the guard reads the same cached answer a moment later: checked
      // OFF means ENABLE, never the unreachable "turn it off first".
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.status).toBe(200);
      expect(JSON.parse((await subshells.findById(id))!.screenConfig!)).toEqual({
        width: 1024,
        height: 768,
        provider: "xvfb-x11vnc",
      });
      expect(sim.countOf("launch")).toBe(2);
    } finally {
      sim.detach();
    }
  });

  it("an offline node with a remembered live display answers the offline sentence, not the duplicate one", async () => {
    // Ordering is part of the story: the guard reads the node's last ports
    // answer, and on a node that died ungracefully that answer may be a
    // memory of a display nobody can turn off. Offline first, always.
    const screen = screenAnswer(":94", 5994);
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => ({ screen }),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen }),
    });
    const id = await seedPane("offline-order", agentNode);
    try {
      expect((await putScreen(id, ownerCookie, { width: 640, height: 480 })).status).toBe(200); // running, live, remembered
      sim.detach(); // the link dies with the display still allocated and the config set
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.status).toBe(409);
      const message = ((await res.json()) as { message: string }).message;
      expect(message).toContain("This node is offline");
      expect(message).not.toContain("already has a virtual display");
    } finally {
      sim.detach(); // idempotent: usually already detached above
    }
  });

  it("the node switch off refuses with the node's own word and writes nothing", async () => {
    const sim = attachScriptedNode(offNode, toggleHandlers());
    const id = await seedPane("switchoff", offNode);
    try {
      const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toContain("(preview-node-off)");
      expect((await subshells.findById(id))!.screenConfig).toBeNull(); // the spec's crux: refusal wrote nothing
    } finally {
      sim.detach();
    }
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

  it("an offline node refuses the enable: 409 and no write", async () => {
    const id = await seedPane("offline", agentNode);
    // No attach at all: isNodeOffline reads the registry empty.
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });

  it("a relaunch the node refuses rolls the new screen back to what the row had", async () => {
    // The route's named guarantee, on the one refusal that fires AFTER the
    // write: the kill lands, the relaunch is refused, and the row must not
    // keep a desired screen nobody applied. The node-side failure has no
    // named mapping, so the status itself is the generic 5xx; the guarantee
    // under test is the column.
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => new Error("xvfb would not start"),
    });
    const id = await seedPane("rollback", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    try {
      const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
      expect(res.ok).toBe(false);
      expect((await subshells.findById(id))!.screenConfig).toContain("800"); // the prior value is back
      expect(sim.countOf("launch")).toBe(1); // it really tried the relaunch
    } finally {
      sim.detach();
    }
  });

  it("an enable while a restart is in flight refuses the join and rolls its write back", async () => {
    // The in-flight revival composed its launch from the row it read BEFORE
    // this write, so joining would answer 200 for a screen the pane never
    // got. The flip declines the lease and its 409 asks the caller to try
    // again once the restart lands (the swap path's RestartInFlightSwapError
    // is the sibling this mirrors).
    let releaseLaunch!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => held.then(() => undefined),
    });
    const id = await seedPane("join", agentNode);
    try {
      const restart = postRestart(id, ownerCookie); // in flight, held at its launch frame
      await waitUntil(() => sim.countOf("launch") > 0, "the plain restart's launch frame");
      const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
      const body = (await res.json()) as { code: string; message: string };
      expect(res.status).toBe(409);
      expect(body.code).toBe(BackendErrorCodes.RESTART_IN_FLIGHT);
      expect(body.message).toContain("already restarting");
      expect((await subshells.findById(id))!.screenConfig).toBeNull(); // rolled back, not left applied
      releaseLaunch();
      expect((await restart).ok).toBe(true); // the held restart itself lands
    } finally {
      releaseLaunch();
      sim.detach();
    }
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
    try {
      const id = await seedPane("off", agentNode);
      await subshells.update(id, {
        screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }),
      });
      const res = await deleteScreen(id, ownerCookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { closed: boolean }).closed).toBe(true); // the scripted answer
      expect((await subshells.findById(id))!.screenConfig).toBeNull();
      expect(sim.cmdsOf("preview_display_close")).toEqual([{ type: "preview_display_close", paneId: id }]);
    } finally {
      sim.detach();
    }
  });

  it("with nothing allocated it is still a 200 and still sends the close (repeat-off converges)", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    try {
      const id = await seedPane("none", agentNode);
      const res = await deleteScreen(id, ownerCookie);
      expect(res.status).toBe(200);
      expect(sim.cmdsOf("preview_display_close").length).toBe(1);
      expect((await subshells.findById(id))!.screenConfig).toBeNull();
    } finally {
      sim.detach();
    }
  });

  it("the built-in local node tears the display down through the runtime, never a wire command", async () => {
    // The `local` branch calls the plane's own runtime directly (the local
    // command chain refuses display verbs), so nothing may touch the node
    // registry here: no attach exists and none is needed for the 200.
    const id = await seedPane("off-local", LOCAL_NODE_ID);
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { closed: boolean }).closed).toBe(false); // nothing was allocated
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
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

  it("a close the node refused says the node answered no, quotes its word, and is not the drop story", async () => {
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      preview_display_close: () => new Error("preview plumbing unavailable in this daemon context"),
    });
    const id = await seedPane("off-refused", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    try {
      const res = await deleteScreen(id, ownerCookie);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(BackendErrorCodes.NODE_UNREACHABLE);
      expect(body.message).toContain("The node answered it would not close the display");
      expect(body.message).toContain("The node said: preview plumbing unavailable in this daemon context");
      // The other branches' sentences are other stories: this node ANSWERED.
      expect(body.message).not.toContain("dropped while its display was closing");
      expect(body.message).not.toContain("didn't answer");
      // Desired-state-first still holds: the refusal keeps the saved wish cleared.
      expect((await subshells.findById(id))!.screenConfig).toBeNull();
    } finally {
      sim.detach();
    }
  });

  it("a node too old to know the close command answers the update sentence, not the silence one", async () => {
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      preview_display_close: () => new Error("unsupported"), // the agent's wire word
    });
    const id = await seedPane("off-old", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    try {
      const res = await deleteScreen(id, ownerCookie);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(BackendErrorCodes.NODE_AGENT_TOO_OLD);
      expect(body.message).toContain("doesn't support closing a display");
      expect(body.message).not.toContain("didn't answer");
      expect((await subshells.findById(id))!.screenConfig).toBeNull(); // cleared before the attempt
    } finally {
      sim.detach();
    }
  });

  it("a node that goes silent mid-close answers the didn't-answer sentence after the RPC deadline", async () => {
    // The one slow case in this suite: it waits out the RPC's own 10 s
    // deadline (DEFAULT_COMMAND_TIMEOUT_MS), so the case carries an explicit
    // timeout rather than bun's 5 s default.
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      preview_display_close: () => new Promise<never>(() => {}), // the frame never goes back
    });
    const id = await seedPane("off-silent", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    try {
      const res = await deleteScreen(id, ownerCookie);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(BackendErrorCodes.NODE_UNREACHABLE);
      expect(body.message).toContain("didn't answer");
      expect((await subshells.findById(id))!.screenConfig).toBeNull();
    } finally {
      sim.detach();
    }
  }, 20_000);

  it("the close audit names the acting viewer beside the wire's reason word", async () => {
    // A user toggle and a node teardown both end in "revoked" (that union is
    // the node's wire vocabulary, not audit prose), so the row's ACTOR column
    // is what tells them apart, the way the enable side's restart row names
    // its grantee.
    const screen = screenAnswer(":93", 5993);
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => ({ screen }),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen }),
    });
    const id = await seedPane("off-audit", agentNode);
    try {
      expect((await putScreen(id, ownerCookie, { width: 640, height: 480 })).status).toBe(200);
      expect(((await (await deleteScreen(id, ownerCookie)).json()) as { closed: boolean }).closed).toBe(true);
      const rows = await db
        .selectFrom("auditEvents")
        .where("action", "=", "node.preview_display.close")
        .where("metadataJson", "like", `%${id}%`)
        .select(["actorUserId", "metadataJson"])
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorUserId).toBe(ownerId);
      const meta = JSON.parse(String(rows[0]!.metadataJson)) as { paneId: string; reason: string; display: string };
      expect(meta.paneId).toBe(id);
      expect(meta.display).toBe(":93");
      expect(meta.reason).toBe("revoked");
    } finally {
      sim.detach();
    }
  });

  it("a successful close drops the ports cache: the same-window /views reads the pane OFF without waiting", async () => {
    const screen = screenAnswer(":92", 5992);
    let displayOpen = true;
    const sim = attachScriptedNode(agentNode, {
      ...toggleHandlers(),
      launch: () => ({ screen }),
      preview_ports_get: () =>
        displayOpen ? { ports: [], cdpPort: null, screen } : { ports: [], cdpPort: null, screen: null },
      preview_display_close: () => {
        displayOpen = false;
        return { closed: true };
      },
    });
    const id = await seedPane("off-cache", agentNode);
    try {
      expect((await putScreen(id, ownerCookie, { width: 640, height: 480 })).status).toBe(200);
      const warm = (await (await getViews(id, ownerCookie)).json()) as { screen: unknown };
      expect(warm.screen).toEqual(screen); // this read caches the live answer...
      const off = await deleteScreen(id, ownerCookie);
      expect(((await off.json()) as { closed: boolean }).closed).toBe(true);
      // ...and the close must have invalidated it: still inside the 5 s window,
      // the next read re-asks the node and the gone display reads OFF.
      const after = (await (await getViews(id, ownerCookie)).json()) as { screen: unknown };
      expect(after.screen).toBeNull();
    } finally {
      sim.detach();
    }
  });
});
