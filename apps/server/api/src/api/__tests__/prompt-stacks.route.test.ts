import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { promptsRoutes } from "@/api/prompts.route.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `/api/prompts/stacks` (spec 2026-09-29). The rules this suite pins are the
 * ones the design conversation decided: the stack list rides the SAME mount as
 * prompts and `/stacks` must win over `/:id`; membership is live (delete a
 * prompt, the member goes and the stack survives EMPTY; unshare a member, it
 * drops from the viewer's copy and returns on re-share); the ownership axis
 * (foreign stack 404, never 403); the joined-20000 save-time cap; and writes on
 * the `prompts` token scope with the legacy-map pass.
 */
const app = new Elysia().use(errorHandlerPlugin).use(promptsRoutes);

const subshells = new SubshellsRepository(db);

interface StackItemView {
  id: string;
  promptId?: string;
  description: string;
  body: string;
  ownerName?: string;
}
interface StackView {
  id: string;
  label: string;
  shared?: boolean;
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
  items: StackItemView[];
}

let seq = 0;
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

const ownerEmail = `stk-owner-${unique("u")}@subshell.local`;
const readerEmail = `stk-reader-${unique("u")}@subshell.local`;
const pw = "stacks-route-pass-1";
const createdStackIds: string[] = [];
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
  return { status: res.status, json: json as { code?: string; message?: string; ok?: boolean } };
}

async function callJson<T>(path: string, opts: Parameters<typeof call>[1] = {}) {
  const res = await call(path, opts);
  return { status: res.status, json: res.json as unknown as T };
}

/** Create a prompt through the real route (the stack members are real rows). */
async function mkPrompt(cookie: string, description: string, body: string, shared = false): Promise<string> {
  const res = await callJson<{ id: string }>("/", { cookie, body: { description, body, shared } });
  createdPromptIds.push(res.json.id);
  return res.json.id;
}

async function mkStack(cookie: string, label: string, items: unknown[], shared = false): Promise<StackView> {
  const res = await callJson<StackView>("/stacks", { cookie, body: { label, items, shared } });
  if (res.status === 200) createdStackIds.push(res.json.id);
  return res.json;
}

async function mintKey(userId: string, permissions: Record<string, string[]>): Promise<string> {
  const sid = unique("sess");
  createdSubshellIds.push(sid);
  await subshells.create({
    id: sid,
    userId,
    presetId: null,
    harnessId: "claude-code",
    name: `stk-${sid.slice(0, 8)}`,
    workingDir: "/tmp",
    tmuxSocket: `stk-sock-${sid}`,
    nodeId: "local",
    status: "terminated",
    alive: 0,
  });
  const created = (await getAuth().api.createApiKey({
    body: {
      name: `sess:${sid}`,
      userId,
      expiresIn: 60 * 60 * 24,
      metadata: { kind: "subshell", subshellId: sid },
      permissions,
    },
  })) as unknown as { key: string; id: string };
  await subshells.update(sid, { apiKeyId: created.id });
  return created.key;
}

describe("/api/prompts/stacks (spec 2026-09-29)", () => {
  let ownerId: string;
  let ownerCookie: string;
  let _readerId: string;
  let readerCookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: "Stack Owner",
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
    for (const id of createdStackIds) await db.deleteFrom("promptStacks").where("id", "=", id).execute();
    for (const id of createdPromptIds) await db.deleteFrom("prompts").where("id", "=", id).execute();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const email of [ownerEmail, readerEmail]) await deleteUserByEmailOrId(email);
  });

  it("GET /stacks answers the list shape, and /stacks is NOT swallowed by /:id", async () => {
    const list = await callJson<{ own: StackView[]; shared: StackView[] }>("/stacks", { cookie: ownerCookie });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json.own)).toBe(true);
    expect(Array.isArray(list.json.shared)).toBe(true);
    // The proof the static path won: a prompt-id lookup on "stacks" would 404
    // the getPrompt route; the LIST answered instead.
    expect((await call("/stacks")).status).toBe(401); // gated, not absent
  });

  it("creates with a trimmed label and ordered members (refs + inline), reads back in own", async () => {
    const p1 = await mkPrompt(ownerCookie, "P1", "one");
    const p2 = await mkPrompt(ownerCookie, "P2", "two");
    const s = await mkStack(ownerCookie, "  Morning set  ", [
      { promptId: p1 },
      { body: "my own text", description: "Note" },
      { promptId: p2 },
    ]);
    expect(s.label).toBe("Morning set");
    expect(s.shared).toBe(false);
    expect(s.items.map((i) => i.body)).toEqual(["one", "my own text", "two"]);
    expect(s.items.map((i) => i.description)).toEqual(["P1", "Note", "P2"]);
    expect(s.items[0]?.promptId).toBe(p1);
    expect(s.items[1]?.promptId).toBeUndefined();
    const list = await callJson<{ own: StackView[] }>("/stacks", { cookie: ownerCookie });
    expect(list.json.own.map((x) => x.id)).toContain(s.id);
  });

  it("a shared stack enters every OTHER account's shared list with the owner's name", async () => {
    const p = await mkPrompt(ownerCookie, "Mine", "shared-stack-member", true);
    const s = await mkStack(ownerCookie, "Public set", [{ promptId: p }], true);
    const readers = await callJson<{ own: StackView[]; shared: StackView[] }>("/stacks", { cookie: readerCookie });
    expect(readers.json.shared.find((x) => x.id === s.id)?.ownerName).toBe("Stack Owner");
    expect(readers.json.own.map((x) => x.id)).not.toContain(s.id);
    const owners = await callJson<{ own: StackView[]; shared: StackView[] }>("/stacks", { cookie: ownerCookie });
    expect(owners.json.own.map((x) => x.id)).toContain(s.id);
    expect(owners.json.shared.map((x) => x.id)).not.toContain(s.id); // own never rides its shared tab
    const detail = await callJson<StackView>(`/stacks/${s.id}`, { cookie: readerCookie });
    expect(detail.status).toBe(200);
    expect(detail.json.ownerName).toBe("Stack Owner");
    expect(detail.json.items[0]?.body).toBe("shared-stack-member");
  });

  it("a SHARED STACK whose members are private reads as empty to others (the drop, in miniature)", async () => {
    const privateMember = await mkPrompt(ownerCookie, "Private member", "mine alone");
    const s = await mkStack(ownerCookie, "Over-shared set", [{ promptId: privateMember }], true);
    const readers = await callJson<{ own: StackView[]; shared: StackView[] }>("/stacks", { cookie: readerCookie });
    const copy = readers.json.shared.find((x) => x.id === s.id);
    expect(copy).toBeDefined(); // the STACK is shared and visible…
    expect(copy?.items).toEqual([]); // …its private member is not, and it is not mentioned
    const owners = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(owners.json.items).toHaveLength(1); // the owner's copy is whole
  });

  it("membership is LIVE: the member follows the prompt's text, and its DEATH (stack survives empty)", async () => {
    const p = await mkPrompt(ownerCookie, "Doomed", "original");
    const s = await mkStack(ownerCookie, "Doomed set", [{ promptId: p }, { body: "stays inline" }]);
    // Edit shows through:
    await callJson(`/${p}`, { cookie: ownerCookie, method: "PUT", body: { body: "edited text" } });
    const afterEdit = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(afterEdit.json.items[0]?.body).toBe("edited text");
    // Delete removes the member, the stack lives, and it is EMPTY:
    await call(`/${p}`, { cookie: ownerCookie, method: "DELETE" });
    const afterDelete = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.json.items).toHaveLength(1);
    expect(afterDelete.json.items[0]?.body).toBe("stays inline");
    const emptied = await callJson<StackView>(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { items: [] },
    });
    expect(emptied.status).toBe(200);
    expect(emptied.json.items).toEqual([]); // an empty stack is a state, and it reads
  });

  it("UNSHARING a member prompt drops it from every viewer's copy and returns on re-share", async () => {
    const sharedByReader = await mkPrompt(readerCookie, "Reader public", "visible in stacks", true);
    const s = await mkStack(ownerCookie, "Mixed set", [{ promptId: sharedByReader }, { body: "inline" }]);
    const before = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(before.json.items).toHaveLength(2);
    expect(before.json.items[0]?.ownerName).toContain("stk-reader"); // foreign member carries its owner
    await callJson(`/${sharedByReader}`, { cookie: readerCookie, method: "PUT", body: { shared: false } });
    const during = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(during.json.items).toHaveLength(1); // dropped, no answer about what vanished
    expect(during.json.items[0]?.body).toBe("inline");
    await callJson(`/${sharedByReader}`, { cookie: readerCookie, method: "PUT", body: { shared: true } });
    const after = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(after.json.items).toHaveLength(2); // and the member returns: nothing was destroyed
  });

  it("a full-replace save PRESERVES a member the caller cannot see (re-share survives a save)", async () => {
    // The H1 rule: the read hides an unshared member, so the caller's save can
    // never NAME it - rewriting the visible set must not silently destroy the
    // invisible row, or the re-share above would have nothing to return.
    const hidden = await mkPrompt(readerCookie, "Hidable", "still a member", true);
    const s = await mkStack(ownerCookie, "Half visible", [{ promptId: hidden }, { body: "kept" }]);
    await callJson(`/${hidden}`, { cookie: readerCookie, method: "PUT", body: { shared: false } }); // now invisible to owner
    // Owner re-saves the members they CAN see (a dialog label-edit + visible set):
    const saved = await callJson<StackView>(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { label: "Renamed half", items: [{ body: "kept" }, { body: "added" }] },
    });
    expect(saved.json.label).toBe("Renamed half");
    expect(saved.json.items.map((i) => i.body)).toEqual(["kept", "added"]); // the hidden one is not shown…
    await callJson(`/${hidden}`, { cookie: readerCookie, method: "PUT", body: { shared: true } }); // re-shared
    const back = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    // …and it was still there: it lands behind the rewritten set, its relative
    // order intact, exactly as the "returns on re-share" ruling promises.
    expect(back.json.items.map((i) => i.body)).toEqual(["kept", "added", "still a member"]);
  });

  it("PUT re-checks the joined cap and the member-visibility on a full replace; MAX_STACK_ITEMS holds", async () => {
    const p = await mkPrompt(ownerCookie, "Long", "a".repeat(12000));
    const foreignPrivate = await mkPrompt(readerCookie, "Theirs PUT", "private");
    const s = await mkStack(ownerCookie, "Cap checks", [{ body: "seed" }]);
    // The joined cap is a PUT rule too, not just a create rule.
    expect(
      (
        await call(`/stacks/${s.id}`, {
          cookie: ownerCookie,
          method: "PUT",
          body: { items: [{ body: "b".repeat(9000) }, { promptId: p }] },
        })
      ).status,
    ).toBe(400);
    // A caller cannot inject a prompt they cannot see by way of a full replace…
    const inj = await call(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { items: [{ promptId: foreignPrivate }] },
    });
    expect(inj.status).toBe(400);
    // …and the refusal leaves the members exactly as they were (not a partial
    // rewrite): the seed is still the only member.
    const afterInject = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(afterInject.json.items.map((i) => i.body)).toEqual(["seed"]);
    // The row-count bound (the joined cap is the real limit; this is row sanity).
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ body: `r${i}` }));
    expect((await call("/stacks", { cookie: ownerCookie, body: { label: "Huge", items: tooMany } })).status).toBe(400);
    // A boundary save (exactly 50) is accepted.
    const ok = await call(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { items: Array.from({ length: 50 }, (_, i) => ({ body: `r${i}` })) },
    });
    expect(ok.status).toBe(200);
  });

  it("refuses: whitespace label, empty items, both-or-neither members, invisible promptId, joined > 20000", async () => {
    const foreignPrivate = await mkPrompt(readerCookie, "Theirs", "private body");
    const p = await mkPrompt(ownerCookie, "Long", "a".repeat(12000));
    for (const [body, why] of [
      [{ label: "  ", items: [{ body: "x" }] }, "whitespace label"],
      [{ label: "L", items: [] }, "empty items on create"],
      [{ label: "L", items: [{ promptId: p, body: "both" }] }, "promptId+body (both kinds)"],
      [{ label: "L", items: [{ promptId: p, description: "d" }] }, "promptId+description (both kinds)"],
      [{ label: "L", items: [{ description: "orphan label" }] }, "neither kind"],
      [{ label: "L", items: [{ promptId: foreignPrivate }] }, "invisible promptId"],
      [{ label: "L", items: [{ body: "b".repeat(9000) }, { promptId: p }] }, "joined over the cap"],
    ] as const) {
      const res = await call("/stacks", { cookie: ownerCookie, body });
      expect(res.status, `${why}: ${JSON.stringify(res.json?.message)}`).toBe(400);
    }
  });

  it("PUT replaces order, renames, flips shared; stray and empty patches are 400s", async () => {
    const p1 = await mkPrompt(ownerCookie, "A", "aa");
    const p2 = await mkPrompt(ownerCookie, "B", "bb");
    const s = await mkStack(ownerCookie, "Order", [{ promptId: p1 }, { promptId: p2 }]);
    const swapped = await callJson<StackView>(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { items: [{ promptId: p2 }, { promptId: p1 }] },
    });
    expect(swapped.json.items.map((i) => i.promptId)).toEqual([p2, p1]);
    const renamed = await callJson<StackView>(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { label: "Renamed", shared: true },
    });
    expect(renamed.json.label).toBe("Renamed");
    expect(renamed.json.shared).toBe(true);
    expect(renamed.json.items).toHaveLength(2); // label-only patch leaves members alone
    const stray = await call(`/stacks/${s.id}`, { cookie: ownerCookie, method: "PUT", body: { promptId: p1 } });
    expect(stray.status).toBe(400);
    expect(stray.json.message).toContain("promptId");
    expect((await call(`/stacks/${s.id}`, { cookie: ownerCookie, method: "PUT", body: {} })).status).toBe(400);
  });

  it("a PUT with a whitespace label 400s WITHOUT rewriting the members (atomicity)", async () => {
    // The label clears the schema (minLength passes "   ") and fails only in
    // cleanLabel; deriving it after the replace would have rewritten the set
    // and THEN refused - the dialog errors while the members silently changed.
    const p = await mkPrompt(ownerCookie, "Kept member", "keep me");
    const s = await mkStack(ownerCookie, "Atomic label", [{ promptId: p }]);
    const bad = await call(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { label: "   ", items: [{ body: "should-not-land" }] },
    });
    expect(bad.status).toBe(400);
    const after = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(after.json.label).toBe("Atomic label"); // not written
    expect(after.json.items.map((i) => i.body)).toEqual(["keep me"]); // not rewritten
  });

  it("accepts a stack whose joined text is EXACTLY the 20000 cap (the boundary is >, not >=)", async () => {
    // Two inline members joined by "\n\n": 10000 + 2 + 9998 = 20000 exactly.
    const res = await callJson<StackView>("/stacks", {
      cookie: ownerCookie,
      body: { label: "Exactly cap", items: [{ body: "x".repeat(10000) }, { body: "y".repeat(9998) }] },
    });
    expect(res.status).toBe(200);
    createdStackIds.push(res.json.id);
  });

  it("a preserved invisible member counts toward the cap: a save cannot hide an over-cap stack", async () => {
    // A member the owner cannot see (reader's private prompt) sits in the stack
    // with a huge body. The owner re-saves only the visible half; the preserved
    // row still ships at launch, so the FULL joined text must be measured - the
    // save 400s even though the visible set alone is small.
    const hidden = await mkPrompt(readerCookie, "Hidden huge", "z".repeat(19999), true);
    const s = await mkStack(ownerCookie, "Over via hidden", [{ promptId: hidden }]);
    await callJson(`/${hidden}`, { cookie: readerCookie, method: "PUT", body: { shared: false } }); // now invisible
    const save = await call(`/stacks/${s.id}`, {
      cookie: ownerCookie,
      method: "PUT",
      body: { items: [{ body: "small visible edit" }] },
    });
    expect(save.status).toBe(400); // 19999 (preserved) + "\n\n" + 18 far exceeds 20000
    // The cap fired BEFORE the rewrite, so the visible half the owner tried to
    // save ("small visible edit") never landed: re-share the hidden prompt and
    // the stack is still exactly its original single member.
    await callJson(`/${hidden}`, { cookie: readerCookie, method: "PUT", body: { shared: true } });
    const after = await callJson<StackView>(`/stacks/${s.id}`, { cookie: ownerCookie });
    expect(after.json.items.map((i) => i.body)).toEqual(["z".repeat(19999)]);
  });

  it("the ownership axis: a foreign stack is 404 on every path, never 403, never an oracle", async () => {
    const s = await mkStack(ownerCookie, "Private set", [{ body: "secret inline" }]);
    expect((await call(`/stacks/${s.id}`, { cookie: readerCookie })).status).toBe(404);
    expect((await call(`/stacks/${s.id}`, { cookie: readerCookie, method: "PUT", body: {} })).status).toBe(404);
    expect((await call(`/stacks/${s.id}`, { cookie: readerCookie, method: "DELETE" })).status).toBe(404);
    // The reader never lists it, and its label never rides any read.
    const readers = await call("/stacks", { cookie: readerCookie });
    expect(JSON.stringify(readers.json)).not.toContain(s.id);
    expect(JSON.stringify(readers.json)).not.toContain("Private set");
  });

  it("DELETE removes the stack and the member PROMPTS survive", async () => {
    const p = await mkPrompt(ownerCookie, "Survivor", "i remain");
    const s = await mkStack(ownerCookie, "Temp", [{ promptId: p }]);
    expect((await call(`/stacks/${s.id}`, { cookie: ownerCookie, method: "DELETE" })).json).toEqual({ ok: true });
    expect((await call(`/stacks/${s.id}`, { cookie: ownerCookie })).status).toBe(404);
    expect((await callJson<{ id: string }>(`/${p}`, { cookie: ownerCookie })).status).toBe(200);
  });

  it("bearer on the prompts scope full-CRUDs stacks; prompts:[read] refuses writes; legacy map passes", async () => {
    const key = await mintKey(ownerId, {
      channels: ["read", "write"],
      subshells: ["read", "write"],
      prompts: ["read", "write"],
    });
    const created = await callJson<StackView>("/stacks", {
      bearer: key,
      body: { label: "From a pane", items: [{ body: "x" }] },
    });
    expect(created.status).toBe(200);
    createdStackIds.push(created.json.id);
    const owners = await callJson<{ own: StackView[] }>("/stacks", { cookie: ownerCookie });
    expect(owners.json.own.map((x) => x.id)).toContain(created.json.id); // the pane acts as its owner
    expect((await call(`/stacks/${created.json.id}`, { bearer: key, method: "DELETE" })).status).toBe(200);

    // A key whose permission map predates `prompts` passes the legacy tier on
    // BOTH read and write (the prompts twin pins the write half).
    const legacy = await mintKey(ownerId, { channels: ["read", "write"], subshells: ["read", "write"] });
    expect((await call("/stacks", { bearer: legacy })).status).toBe(200);
    const legacyWrite = await callJson<StackView>("/stacks", {
      bearer: legacy,
      body: { label: "Legacy write", items: [{ body: "x" }] },
    });
    expect(legacyWrite.status).toBe(200);
    createdStackIds.push(legacyWrite.json.id);

    const readOnly = await mintKey(ownerId, {
      channels: ["read", "write"],
      subshells: ["read", "write"],
      prompts: ["read"],
    });
    expect((await call("/stacks", { bearer: readOnly })).status).toBe(200);
    expect((await call("/stacks", { bearer: readOnly, body: { label: "L", items: [{ body: "x" }] } })).status).toBe(
      403,
    );
  });

  it("anonymous is 401", async () => {
    expect((await call("/stacks")).status).toBe(401);
  });
});
