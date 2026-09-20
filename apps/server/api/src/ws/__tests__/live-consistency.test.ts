import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { listSubshellsRoute } from "@/api/subshells/list-subshells.route.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { handleLiveClose, handleLiveOpen, type LiveWsSocket, liveWsDeps } from "@/ws/live-ws.js";
import { issueWsToken } from "@/ws/ws-token.js";

/**
 * The invariant this pair MUST hold: the live feed's snapshot and
 * `GET /api/subshells` return the SAME set for the same viewer.
 *
 * Both are producers of one client cache key (`SUBSHELLS_QUERY_KEY`): the root
 * feed provider writes every snapshot into it and REST refetches overwrite it.
 * While the feed used the owner-only `SubshellManagerService.listSubshells` and
 * REST used the sharing/admin-aware `SubshellsService.listSubshells`, an admin
 * saw another user's subshell pop IN on a REST refetch and OUT on the next
 * 1.5 s frame — the sidebar row visibly flickered (live report 2026-09-03,
 * "mac-builder.local keeps popping in and out").
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

  it("the admin's first snapshot contains what the admin's REST list contains", async () => {
    const restRes = await app.fetch(authedRequest("/api/subshells", adminCookie));
    expect(restRes.status).toBe(200);
    const rest = (await restRes.json()) as { id: string }[];
    // Sanity: REST's admin visibility DOES include the foreign row (the set
    // the client cache should converge to).
    expect(rest.map((s) => s.id)).toContain(subshellIds[0]);

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
