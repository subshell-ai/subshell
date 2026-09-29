import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { promptsRoutes } from "@/api/prompts.route.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `/api/prompts` (spec 2026-09-28): the saved-prompt library. The rules this
 * suite pins are the ownership axis (a foreign row is 404, never 403, on
 * every path), the everyone-or-none read (a shared row appears in every OTHER
 * account's `shared` list with the owner's name, never in its own), and the
 * bearer scope including the pre-feature map pass.
 */
const app = new Elysia().use(errorHandlerPlugin).use(promptsRoutes);

const subshells = new SubshellsRepository(db);

interface PromptView {
  id: string;
  description: string;
  body: string;
  shared?: boolean;
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
}

let seq = 0;
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

const ownerEmail = `prm-owner-${unique("u")}@subshell.local`;
const readerEmail = `prm-reader-${unique("u")}@subshell.local`;
const pw = "prompts-route-pass-1";
const createdPromptIds: string[] = [];
const createdSubshellIds: string[] = [];

async function call(path: string, opts: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  const res = await app.fetch(
    new Request(`http://localhost:3080/api/prompts${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  let json: unknown = null;
  try {
    json = await res.clone().json();
  } catch {
    /* non-JSON error bodies stay null */
  }
  return { status: res.status, json: json as { code?: string; message?: string; ok?: boolean } & Partial<PromptView> };
}

/** Mint a bearer key with an EXACT permission map (legacy and partial shapes). */
async function mintKey(userId: string, permissions: Record<string, string[]>): Promise<string> {
  const sid = unique("sess");
  createdSubshellIds.push(sid);
  await subshells.create({
    id: sid,
    userId,
    presetId: null,
    harnessId: "claude-code",
    name: `prm-${sid.slice(0, 8)}`,
    workingDir: "/tmp",
    tmuxSocket: `prm-sock-${sid}`,
    nodeId: "local",
    status: "terminated",
    alive: 0,
  });
  const created = (await getAuth().api.createApiKey({
    body: {
      name: `sess:${sid}`,
      userId,
      // The plugin's floor is 1 day (see the TTL note in subshell-tokens.ts).
      expiresIn: 60 * 60 * 24,
      metadata: { kind: "subshell", subshellId: sid },
      permissions,
    },
  })) as unknown as { key: string; id: string };
  await subshells.update(sid, { apiKeyId: created.id });
  return created.key;
}

describe("/api/prompts (spec 2026-09-28)", () => {
  let ownerId: string;
  let ownerCookie: string;
  let _readerId: string;
  let readerCookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: "Prompt Owner",
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    _readerId = await users.createUser({
      email: readerEmail,
      name: readerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    readerCookie = await signIn(readerEmail, pw);
  });

  afterAll(async () => {
    for (const id of createdPromptIds) await db.deleteFrom("prompts").where("id", "=", id).execute();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const email of [ownerEmail, readerEmail]) await deleteUserByEmailOrId(email);
  });

  it("creates with a trimmed description, reads it back in own", async () => {
    const res = await call("/", {
      cookie: ownerCookie,
      body: { description: "  Kickoff  ", body: "Start the task" },
    });
    expect(res.status).toBe(200);
    expect(res.json.description).toBe("Kickoff");
    expect(res.json.shared).toBe(false);
    const id = res.json.id as string;
    createdPromptIds.push(id);
    const list = await call("", { cookie: ownerCookie });
    const own = (list.json as unknown as { own: PromptView[] }).own;
    expect(own.map((p) => p.id)).toContain(id);
    expect((list.json as unknown as { shared: PromptView[] }).shared).toEqual([]);
  });

  it("refuses an empty or whitespace description and an empty body", async () => {
    for (const body of [
      { description: "", body: "x" },
      { description: "   ", body: "x" },
      { description: "d", body: "" },
    ]) {
      const res = await call("/", { cookie: ownerCookie, body });
      expect(res.status).toBe(400);
    }
  });

  it("a shared prompt enters every OTHER account's shared list with the owner's name", async () => {
    const created = await call("/", {
      cookie: ownerCookie,
      body: { description: "Public kickoff", body: "Shared body", shared: true },
    });
    const id = created.json.id as string;
    createdPromptIds.push(id);

    const readers = await call("", { cookie: readerCookie });
    const shared = (readers.json as unknown as { shared: PromptView[] }).shared;
    expect(shared.find((p) => p.id === id)?.ownerName).toBe("Prompt Owner");
    const own = (readers.json as unknown as { own: PromptView[] }).own;
    expect(own.map((p) => p.id)).not.toContain(id);

    // The owner's own list: it rides `own` only, never its own shared tab.
    const owners = await call("", { cookie: ownerCookie });
    expect((owners.json as unknown as { own: PromptView[] }).own.map((p) => p.id)).toContain(id);
    expect((owners.json as unknown as { shared: PromptView[] }).shared.map((p) => p.id)).not.toContain(id);

    // GET /:id answers for the reader too, with the owner label.
    const detail = await call(`/${id}`, { cookie: readerCookie });
    expect(detail.status).toBe(200);
    expect(detail.json.body).toBe("Shared body");
    expect(detail.json.ownerName).toBe("Prompt Owner");
  });

  it("an unshared prompt is invisible to another account (404, never 403)", async () => {
    const created = await call("/", { cookie: ownerCookie, body: { description: "Private", body: "mine" } });
    const id = created.json.id as string;
    createdPromptIds.push(id);
    expect((await call(`/${id}`, { cookie: readerCookie })).status).toBe(404);
    expect((await call(`/${id}`, { cookie: readerCookie, method: "PUT", body: { body: "hijacked" } })).status).toBe(
      404,
    );
    expect((await call(`/${id}`, { cookie: readerCookie, method: "DELETE" })).status).toBe(404);
    // The PUT did not touch it:
    const detail = await call(`/${id}`, { cookie: ownerCookie });
    expect(detail.json.body).toBe("mine");
    // A stranger never sees it in a list read either.
    const readers = await call("", { cookie: readerCookie });
    expect(JSON.stringify(readers.json)).not.toContain(id);
  });

  it("PUT applies partial patches and flips shared; stray keys are refused", async () => {
    const created = await call("/", { cookie: ownerCookie, body: { description: "Edit me", body: "v1" } });
    const id = created.json.id as string;
    createdPromptIds.push(id);
    const patched = await call(`/${id}`, { cookie: ownerCookie, method: "PUT", body: { body: "v2", shared: true } });
    expect(patched.status).toBe(200);
    expect(patched.json.body).toBe("v2");
    expect(patched.json.shared).toBe(true);
    expect(patched.json.description).toBe("Edit me");
    const stray = await call(`/${id}`, { cookie: ownerCookie, method: "PUT", body: { harnessId: "x" } });
    expect(stray.status).toBe(400);
    expect(stray.json.message).toContain("harnessId");
  });

  it("DELETE removes the row for everyone and answers 404 twice", async () => {
    const created = await call("/", {
      cookie: ownerCookie,
      body: { description: "Doomed", body: "gone", shared: true },
    });
    const id = created.json.id as string;
    expect((await call(`/${id}`, { cookie: ownerCookie, method: "DELETE" })).json).toEqual({ ok: true });
    expect((await call(`/${id}`, { cookie: ownerCookie })).status).toBe(404);
    expect((await call(`/${id}`, { cookie: readerCookie })).status).toBe(404);
  });

  it("a bearer token with the prompts scope full-CRUDs its owner's prompts", async () => {
    const key = await mintKey(ownerId, {
      channels: ["read", "write"],
      subshells: ["read", "write"],
      prompts: ["read", "write"],
    });
    const created = await call("/", { bearer: key, body: { description: "From a pane", body: "pane body" } });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    createdPromptIds.push(id);
    // It lands in the OWNER's own list (the pane acts as its owner).
    const owners = await call("", { cookie: ownerCookie });
    expect((owners.json as unknown as { own: PromptView[] }).own.map((p) => p.id)).toContain(id);
    expect((await call(`/${id}`, { bearer: key, method: "PUT", body: { body: "edited" } })).status).toBe(200);
    expect((await call(`/${id}`, { bearer: key, method: "DELETE" })).status).toBe(200);
    // And the cookie owner sees the row through the same scope the next mint uses:
    void issueSubshellToken; // (the standard mint carries prompts; this test mints shapes explicitly)
  });

  it("a pre-prompts legacy map passes (absence predates the gate)", async () => {
    const legacy = await mintKey(ownerId, { channels: ["read", "write"], subshells: ["read", "write"] });
    const list = await call("", { bearer: legacy });
    expect(list.status).toBe(200);
    const created = await call("/", { bearer: legacy, body: { description: "Legacy write", body: "b" } });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    createdPromptIds.push(id);
  });

  it("a map carrying prompts:[read] refuses writes with 403", async () => {
    const readOnly = await mintKey(ownerId, {
      channels: ["read", "write"],
      subshells: ["read", "write"],
      prompts: ["read"],
    });
    expect((await call("", { bearer: readOnly })).status).toBe(200);
    expect((await call("/", { bearer: readOnly, body: { description: "d", body: "b" } })).status).toBe(403);
  });

  it("anonymous is 401", async () => {
    expect((await call("")).status).toBe(401);
  });
});
