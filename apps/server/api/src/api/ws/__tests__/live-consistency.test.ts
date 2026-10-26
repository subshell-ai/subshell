import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { NodeCommandBody, NodeEvent } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { listSubshellsRoute } from "@/api/subshells/list-subshells.route.js";
import { sendPreviewStreamSocket } from "@/api/ws/live-registry.js";
import { handleLiveClose, handleLiveMessage, handleLiveOpen, type LiveWsSocket, liveWsDeps } from "@/api/ws/live-ws.js";
import { issueWsToken } from "@/api/ws/ws-token.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getPreviewBroker, resetForTests, shutdownPreviewBrokerForTests } from "@/modules/previews/preview-broker.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "@/testing/api/auth-tables.js";

/**
 * The invariant this pair MUST hold: the live feed's snapshot and
 * `GET /api/subshells` return the SAME set for the same viewer.
 *
 * Both are producers of one client cache key (`SUBSHELLS_QUERY_KEY`): the root
 * feed provider writes every snapshot into it and REST refetches overwrite it.
 * While the feed used the owner-only `SubshellManagerService.listSubshells` and
 * REST a wider read, an admin saw another user's subshell pop IN on a REST
 * refetch and OUT on the next frame — the sidebar row visibly flickered (live
 * report 2026-09-03, "mac-builder.local keeps popping in and out"). Since the
 * 2026-10-09 ruling both producers read the SAME owner+grants set for every
 * role, which retires the flicker's widest case rather than reconciling it.
 *
 * Carried over from the `/api/events` SSE route this replaced (spec
 * 2026-09-19). The transport changed; the invariant did not, and it is the one
 * that makes a second list implementation impossible to add quietly.
 */
const app = new Elysia().use(new Elysia({ prefix: "/api/subshells" }).use(listSubshellsRoute));

const password = "live-consistency-pass-1";
const ownerEmail = `live-owner-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `live-admin-${crypto.randomUUID()}@subshell.local`;

let ownerId: string;
let adminId: string;
let adminCookie = "";
const subshellIds: string[] = [];

/**
 * Opens the live feed as `userId` and resolves its first snapshot.
 *
 * Drives the handler directly with the REAL dependencies rather than standing
 * a WebSocket up: what is under test is which list backs the frame, and a
 * socket in the middle would only add flake.
 */
async function firstSnapshot(userId: string): Promise<{ id: string }[]> {
  const token = issueWsToken(userId);
  let resolve: (rows: { id: string }[]) => void = () => {};
  const got = new Promise<{ id: string }[]>((r) => {
    resolve = r;
  });
  const ws: LiveWsSocket = {
    data: { query: { token } },
    send(data: string) {
      const frame = JSON.parse(data) as { type: string; subshells?: { id: string }[] };
      if (frame.type === "snapshot" && frame.subshells) resolve(frame.subshells);
      return 1;
    },
    close() {},
  };
  handleLiveOpen(ws, liveWsDeps());
  try {
    return await Promise.race([
      got,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no snapshot arrived")), 5_000)),
    ]);
  } finally {
    handleLiveClose(ws);
  }
}

describe("the live feed's snapshot matches the REST list (one cache, two producers)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);

    const id = crypto.randomUUID();
    subshellIds.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId: ownerId,
      presetId: "p",
      harnessId: "claude-code",
      name: "foreign-session",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
  });

  afterAll(async () => {
    for (const id of subshellIds) {
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    }
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(adminEmail);
  });

  it("the admin's first snapshot matches the admin's REST list - and both EXCLUDE the foreign row", async () => {
    const restRes = await app.fetch(authedRequest("/api/subshells", adminCookie));
    expect(restRes.status).toBe(200);
    const rest = (await restRes.json()) as { id: string }[];
    // Sanity pin for the 2026-10-09 ruling: the foreign (owner's, unshared)
    // row is NOT in an admin's answer. The invariant the file exists for is
    // snapshot == REST; this asserts WHICH set both must now agree on.
    expect(rest.map((s) => s.id)).toEqual([]);

    const snapshot = await firstSnapshot(adminId);
    expect(snapshot.map((s) => s.id).sort()).toEqual(rest.map((s) => s.id).sort());
  });

  it("the owner's snapshot matches the owner's REST list too", async () => {
    const ownerCookie = await signIn(ownerEmail, password);
    const restRes = await app.fetch(authedRequest("/api/subshells", ownerCookie));
    const rest = (await restRes.json()) as { id: string }[];
    const snapshot = await firstSnapshot(ownerId);
    expect(snapshot.map((s) => s.id).sort()).toEqual(rest.map((s) => s.id).sort());
  });
});

/**
 * The preview half of THE control (§11.14): for `watch` subscriptions, the
 * sockets that receive `preview-stream` for a pane must be EXACTLY the view-+
 * holders that sent `watch`. Same doctrine as the snapshot rows above, with
 * the sharpest edge yet: an admin WITHOUT a grant gets nothing (the 2026-10-09
 * ruling, asserted here at the stream fan-out, not just at the list), and the
 * owner's own second socket that never watched gets nothing.
 *
 * Nothing here stands on a stub: the sockets open through the real
 * `handleLiveOpen` with the real `liveWsDeps()`, the access answers come from
 * real share rows, the revocation rows call the very
 * `closeUnauthorizedForPane` verb the shares route calls, and the frames ride
 * the real broker mechanics with the shipped serializer installed. Only the
 * node link is faked (there is no node), and even that records its commands.
 *
 * Before the revocation rows, note this file carried NO revocation case
 * (its two snapshot rows are pure feed-vs-REST equality). The socket-alive
 * precedent is `live-ws.ts`'s resync path: a client that received a row it
 * cannot render ASKS for the list again and its socket keeps running. These
 * rows match THAT behavior for the stream half: frames stop, the socket
 * lives, the canvas goes dark; nothing closes.
 */

const pvPassword = "live-preview-pass-1";
const pvOwnerEmail = `pv-owner-${crypto.randomUUID()}@subshell.local`;
const pvEditEmail = `pv-edit-${crypto.randomUUID()}@subshell.local`;
const pvViewEmail = `pv-view-${crypto.randomUUID()}@subshell.local`;
const pvAdminEmail = `pv-admin-${crypto.randomUUID()}@subshell.local`;

const PV_NODE = "n-pv-fake";
let pvPaneId = "";
let pvOwnerId = "";
let pvEditId = "";
let pvViewId = "";
let pvAdminId = "";

/** The pane's bridge ref after the per-test open; every row streams from it. */
let pvBridgeRef = "";
const pvFeeds: { ws: LiveWsSocket; closed: { code?: number; reason?: string }[]; sent: string[] }[] = [];

/** Opens the feed as `userId` through the REAL deps and awaits the snapshot. */
async function openFeed(userId: string) {
  const token = issueWsToken(userId);
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws: LiveWsSocket = {
    data: { query: { token } },
    send(data: string) {
      sent.push(data);
      return 1;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
  };
  pvFeeds.push({ ws, closed, sent });
  await handleLiveOpen(ws, liveWsDeps());
  return { ws, closed, sent };
}

function streamCount(feed: { sent: string[] }): number {
  return feed.sent.filter((s) => (JSON.parse(s) as { type: string }).type === "preview-stream").length;
}

function watchPane(ws: LiveWsSocket, paneId: string): Promise<void> {
  return handleLiveMessage(ws, JSON.stringify({ type: "watch", id: paneId }), liveWsDeps());
}

function pvStreamEvent(seq: number): Extract<NodeEvent, { type: "preview_stream" }> {
  return {
    type: "preview_stream",
    ref: pvBridgeRef,
    seq,
    w: 80,
    h: 25,
    ts: 1_780_000_000_000 + seq,
    blob: `pv-${seq}`,
  };
}

/** Shares writes go through the very repository the shares route uses. */
const pvShares = new SubshellSharesRepository(db);

describe("preview-stream reaches EXACTLY the view-+ holders that sent watch (the §11.14 stream half)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    pvOwnerId = await users.createUser({
      email: pvOwnerEmail,
      name: pvOwnerEmail,
      passwordHash: await hashPassword(pvPassword),
      role: "user",
    });
    pvEditId = await users.createUser({
      email: pvEditEmail,
      name: pvEditEmail,
      passwordHash: await hashPassword(pvPassword),
      role: "user",
    });
    pvViewId = await users.createUser({
      email: pvViewEmail,
      name: pvViewEmail,
      passwordHash: await hashPassword(pvPassword),
      role: "user",
    });
    pvAdminId = await users.createUser({
      email: pvAdminEmail,
      name: pvAdminEmail,
      passwordHash: await hashPassword(pvPassword),
      role: "admin",
    });
    pvPaneId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: pvPaneId,
      userId: pvOwnerId,
      presetId: "p",
      harnessId: "claude-code",
      name: "pv-pane",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    await pvShares.replaceForSubshell(
      pvPaneId,
      [
        { granteeUserId: pvEditId, permission: "edit" },
        { granteeUserId: pvViewId, permission: "view" },
      ],
      pvOwnerId,
    );
  });

  beforeEach(async () => {
    // Fake the link, keep the fan-out real: the installed sender is the
    // shipped serializer, so the broker fans out exactly as production
    // would, JSON and all. (Passing it explicitly also makes the rows
    // order-independent against the process-global boot slot in a serial
    // run.) The broker's access seam stays PRODUCTION here: the revocation
    // rows must recompute against the same share rows the routes rewrote.
    resetForTests({
      send: async (_nodeId: string, cmd: NodeCommandBody): Promise<unknown> => {
        if (cmd.type === "preview_open") return { ref: cmd.ref, subscribers: 1 };
        if (cmd.type === "preview_close") return { ref: cmd.ref, closed: true };
        if (cmd.type === "preview_ports_get") return { ports: [], cdpPort: 9222, screen: null };
        return {};
      },
      sendToSockets: sendPreviewStreamSocket,
    });
    await getPreviewBroker().startWatch({ viewerUserId: pvOwnerId, paneId: pvPaneId, nodeId: PV_NODE, port: 9222 });
    const bridge = getPreviewBroker().sessionForPane(pvPaneId);
    if (!bridge) throw new Error("preview matrix: the bridge did not stand");
    pvBridgeRef = bridge.ref;
    pvFeeds.length = 0;
  });

  afterAll(async () => {
    for (const feed of pvFeeds) handleLiveClose(feed.ws);
    shutdownPreviewBrokerForTests();
    await db.deleteFrom("subshellShares").where("subshellId", "=", pvPaneId).execute();
    await db.deleteFrom("subshells").where("id", "=", pvPaneId).execute();
    await deleteUserByEmailOrId(pvOwnerEmail);
    await deleteUserByEmailOrId(pvEditEmail);
    await deleteUserByEmailOrId(pvViewEmail);
    await deleteUserByEmailOrId(pvAdminEmail);
  });

  it("after watch, the sockets that receive frames are EXACTLY the view-+ holders that watched", async () => {
    for (const viewerUserId of [pvEditId, pvViewId]) {
      await getPreviewBroker().startWatch({ viewerUserId, paneId: pvPaneId, nodeId: PV_NODE, port: 9222 });
    }
    const owner = await openFeed(pvOwnerId);
    const ownerSibling = await openFeed(pvOwnerId); // second tab of the same holder, never watches
    const editor = await openFeed(pvEditId);
    const viewer = await openFeed(pvViewId);
    const admin = await openFeed(pvAdminId); // role grants nothing on a foreign pane

    await watchPane(owner.ws, pvPaneId);
    await watchPane(editor.ws, pvPaneId);
    await watchPane(viewer.ws, pvPaneId);
    // ownerSibling and admin send nothing.

    getPreviewBroker().onStreamEvent(PV_NODE, pvStreamEvent(1));

    const recipients = [owner, ownerSibling, editor, viewer, admin].filter((f) => streamCount(f) === 1);
    expect(recipients.length).toBe(3);
    expect(streamCount(owner)).toBe(1); // owner counts as view-+
    expect(streamCount(editor)).toBe(1);
    expect(streamCount(viewer)).toBe(1);
    expect(streamCount(ownerSibling)).toBe(0); // the owner's socket that never watched: nothing
    expect(streamCount(admin)).toBe(0); // an admin without a grant: nothing
    // And what arrived is the frame, blob untouched, id addressed by pane
    // (the bridge ref never crosses to the browser).
    expect(
      owner.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f.type === "preview-stream"),
    ).toEqual({ type: "preview-stream", id: pvPaneId, seq: 1, w: 80, h: 25, blob: "pv-1" });
  });

  it("a watch from an admin with no grant attaches nothing and closes nothing", async () => {
    const admin = await openFeed(pvAdminId);
    // The admin's ROLE must not open the stream: watch resolves through the
    // grants axis like every other pane door, and there is no grant.
    await watchPane(admin.ws, pvPaneId);
    getPreviewBroker().onStreamEvent(PV_NODE, pvStreamEvent(1));
    expect(streamCount(admin)).toBe(0);
    expect(admin.closed).toEqual([]); // invisible reads as silence, never as a close
  });

  it("stops frames to a socket whose grant is removed mid-stream while the socket itself lives", async () => {
    await getPreviewBroker().startWatch({ viewerUserId: pvViewId, paneId: pvPaneId, nodeId: PV_NODE, port: 9222 });
    const owner = await openFeed(pvOwnerId);
    const viewer = await openFeed(pvViewId);
    await watchPane(owner.ws, pvPaneId);
    await watchPane(viewer.ws, pvPaneId);
    getPreviewBroker().onStreamEvent(PV_NODE, pvStreamEvent(1));
    expect([streamCount(owner), streamCount(viewer)]).toEqual([1, 1]);

    // The shares cut, exactly as the route performs it: rewrite the rows,
    // then re-ask the broker's recompute.
    await pvShares.replaceForSubshell(pvPaneId, [{ granteeUserId: pvEditId, permission: "edit" }], pvOwnerId);
    await getPreviewBroker().closeUnauthorizedForPane(pvPaneId);
    getPreviewBroker().onStreamEvent(PV_NODE, pvStreamEvent(2));

    expect(streamCount(viewer)).toBe(1); // seq 2 never arrives
    expect(viewer.closed).toEqual([]); // the socket stays live (the resync precedent: the client re-asks, nothing closes it)
    expect(streamCount(owner)).toBe(2); // untouched holders keep streaming
  });

  it("keeps stream frames flowing through an edit-to-view downgrade (watch is what view buys)", async () => {
    await getPreviewBroker().startWatch({ viewerUserId: pvEditId, paneId: pvPaneId, nodeId: PV_NODE, port: 9222 });
    const editor = await openFeed(pvEditId);
    await watchPane(editor.ws, pvPaneId);
    getPreviewBroker().onStreamEvent(PV_NODE, pvStreamEvent(1));
    expect(streamCount(editor)).toBe(1);

    await pvShares.replaceForSubshell(pvPaneId, [{ granteeUserId: pvEditId, permission: "view" }], pvOwnerId);
    await getPreviewBroker().closeUnauthorizedForPane(pvPaneId);
    getPreviewBroker().onStreamEvent(PV_NODE, pvStreamEvent(2));

    // The stream half: `view` still buys the screencast, so the SAME socket
    // keeps receiving. What the downgrade does close is the EDIT tier
    // (forward lanes) - the split Task 8's broker test owns.
    expect(streamCount(editor)).toBe(2);
    expect(editor.closed).toEqual([]);
  });
});
