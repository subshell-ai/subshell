import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { liveRoutes } from "@/api/live.route.js";
import { listSubshellsRoute } from "@/api/subshells/list-subshells.route.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueWsToken } from "@/ws/ws-token.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The invariant this route pair MUST hold: `GET /api/events` (SSE) and
 * `GET /api/subshells` (REST) return the SAME set for the same viewer.
 *
 * Both are producers of one client cache key (`SUBSHELLS_QUERY_KEY`): the root
 * feed provider writes every SSE frame into it and REST refetches overwrite it.
 * While the SSE tick used the owner-only `SubshellManagerService.listSubshells`
 * and REST used the sharing/admin-aware `SubshellsService.listSubshells`, an
 * admin saw another user's session pop IN on a REST refetch and OUT on the
 * next 1.5s frame — the sidebar row visibly flickered (live report
 * 2026-09-03, "mac-builder.local keeps popping in and out").
 */
const app = new Elysia().use(new Elysia({ prefix: "/api/subshells" }).use(listSubshellsRoute)).use(liveRoutes);

const password = "events-consistency-pass-1";
const ownerEmail = `events-owner-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `events-admin-${crypto.randomUUID()}@subshell.local`;

let ownerId: string;
let adminId: string;
let adminCookie = "";
const subshellIds: string[] = [];

/** Reads the SSE stream's first `data:` frame, then cancels the body. */
async function firstFrame(userId: string): Promise<{ id: string }[]> {
  const token = issueWsToken(userId);
  const res = await app.fetch(new Request(`http://localhost:3080/api/events?token=${encodeURIComponent(token)}`));
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE response has no body to read");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (let i = 0; i < 10; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n\n").find((l) => l.startsWith("data: "));
      if (line) {
        const parsed = JSON.parse(line.slice("data: ".length)) as { subshells: { id: string }[] };
        return parsed.subshells;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`no SSE frame arrived (buffer: ${buffer.slice(0, 120)})`);
}

describe("SSE events feed matches the REST list (one cache, two producers)", () => {
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

  it("the admin's first SSE frame contains what the admin's REST list contains", async () => {
    const restRes = await app.fetch(authedRequest("/api/subshells", adminCookie));
    expect(restRes.status).toBe(200);
    const rest = (await restRes.json()) as { id: string }[];
    // Sanity: REST's admin visibility DOES include the foreign row (the set
    // the client cache should converge to).
    expect(rest.map((s) => s.id)).toContain(subshellIds[0]);

    const frame = await firstFrame(adminId);
    expect(frame.map((s) => s.id).sort()).toEqual(rest.map((s) => s.id).sort());
  });

  it("the owner's frame matches the owner's REST list too", async () => {
    const ownerCookie = await signIn(ownerEmail, password);
    const restRes = await app.fetch(authedRequest("/api/subshells", ownerCookie));
    const rest = (await restRes.json()) as { id: string }[];
    const frame = await firstFrame(ownerId);
    expect(frame.map((s) => s.id).sort()).toEqual(rest.map((s) => s.id).sort());
  });
});
