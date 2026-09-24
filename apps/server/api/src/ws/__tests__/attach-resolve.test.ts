import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import type { AttachParams } from "@/ws/attach-params.js";
import { attachJournalLine, resolveAttach } from "@/ws/attach-resolve.js";
import { consumeWsToken, issueWsToken } from "@/ws/ws-token.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../api/__tests__/helpers/auth-tables.js";

/**
 * The attach's authorization half, exercised WITHOUT a WebSocket — which is
 * the point of splitting it out. Every case here used to require standing up
 * a socket and reading close codes off it.
 */

let seq = 0;

/** Seeds a subshell owned by a fresh synthetic user. */
async function seedRow() {
  const { repos } = getRequestlessContext();
  seq += 1;
  return repos.subshells.create({
    id: crypto.randomUUID(),
    userId: `u-attach-resolve-${seq}`,
    presetId: "p-test",
    harnessId: "shell",
    name: "attach-resolve",
    workingDir: "/tmp",
    tmuxSocket: "subshell-attach-resolve",
  });
}

/** An attach request with no cookie and a neutral UA. */
function request(query: string): Parameters<typeof resolveAttach>[0] {
  return { url: new URL(`ws://localhost/ws?${query}`), cookieHeader: "", attachUa: "test-ua" };
}

beforeAll(async () => {
  await runMigrations();
});

/** A minimal AttachParams for the journal-line builder, overridable per test. */
function lineParams(over: Partial<AttachParams> = {}): AttachParams {
  return {
    size: null,
    deviceLabel: "d",
    hidden: false,
    build: "abc123",
    wireMode: "json",
    ...over,
  };
}

describe("resolveAttach cookie fallback: the disabled-account gate", () => {
  const email = `attach-disabled-${crypto.randomUUID()}@subshell.local`;
  const pw = "attach-disabled-pass-1";
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
  });

  afterAll(async () => {
    await db.updateTable("userMeta").set({ disabled: 0 }).where("userId", "=", userId).execute();
    await db.deleteFrom("subshells").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
  });

  /** Seed a row the disabled user OWNS, so access would otherwise pass. */
  async function ownedRow(): Promise<string> {
    const { repos } = getRequestlessContext();
    const row = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId,
      presetId: "p-test",
      harnessId: "shell",
      name: "attach-disabled",
      workingDir: "/tmp",
      tmuxSocket: "subshell-attach-resolve",
    });
    return row.id;
  }

  function cookieRequest(subshellId: string): Parameters<typeof resolveAttach>[0] {
    return {
      url: new URL(`ws://localhost/ws?subshell=${subshellId}`),
      cookieHeader: `better-auth.session_token=${cookie}`,
      attachUa: "test-ua",
    };
  }

  it("refuses the disabled user's cookie on the no-token upgrade path", async () => {
    // `authGuard` applies `accountDisabled` on every REST surface; this is the
    // second door into the same pane. The flag is written DIRECTLY (not
    // through the admin route, whose transaction also revokes the session),
    // because the fixture IS the transient the check exists for: the flag set
    // and a session still live. Pre-fix this reaches access resolution with a
    // live session on an owned row and ADMITS — the failure is the finding.
    const rowId = await ownedRow();
    await db.updateTable("userMeta").set({ disabled: 1 }).where("userId", "=", userId).execute();
    expect(await resolveAttach(cookieRequest(rowId))).toEqual({
      ok: false,
      code: 4001,
      reason: "unauthorized",
    });
  });

  it("admits the same cookie once re-enabled — the flag decides, not the session", async () => {
    await db.updateTable("userMeta").set({ disabled: 0 }).where("userId", "=", userId).execute();
    const rowId = await ownedRow();
    const out = await resolveAttach(cookieRequest(rowId));
    expect(out.ok).toBe(true);
    // The cookie path names the session's user — same field the disable
    // sweep reads, whichever door admitted the socket.
    if (out.ok) expect(out.userId).toBe(userId);
  });
});
describe("resolveAttach token branch: the disabled-account re-ask", () => {
  // The `handleNodeOpen` post-attach doctrine, on the other check-then-act
  // pair that ends in a live socket. The mint passes `authGuard`, the
  // disable commits, `dropUserTokensFor` walks the store — and a mint whose
  // insert lands after that walk survives the sweep for its full 30 s.
  // Redemption consulting the store ALONE would let exactly that attach;
  // the re-ask is what cannot be beaten, because it reads the flag at
  // redeem time rather than racing the sweep.
  const email = `attach-token-dis-${crypto.randomUUID()}@subshell.local`;
  const pw = "attach-token-dis-1";
  let userId: string;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
  });

  afterAll(async () => {
    await db.updateTable("userMeta").set({ disabled: 0 }).where("userId", "=", userId).execute();
    await db.deleteFrom("subshells").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
  });

  /** Seed a row the user OWNS — access would otherwise pass; only the flag refuses. */
  async function ownedRow(): Promise<string> {
    const { repos } = getRequestlessContext();
    const row = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId,
      presetId: "p-test",
      harnessId: "shell",
      name: "attach-token-dis",
      workingDir: "/tmp",
      tmuxSocket: "subshell-attach-resolve",
    });
    return row.id;
  }

  const setDisabled = (v: 0 | 1) =>
    db.updateTable("userMeta").set({ disabled: v }).where("userId", "=", userId).execute();

  it("refuses a token that lands after the disable's store sweep — uniform 4001, and burned", async () => {
    const rowId = await ownedRow();
    await setDisabled(1);
    // The scripted interleave: the sweep has already walked the store (this
    // entry was not in it when it passed), and the client redeems inside the
    // 30 s life. Pre-fix the token branch trusted the store alone and ADMIT
    // — the failure is the finding.
    const token = issueWsToken(userId);
    const refused = await resolveAttach(request(`subshell=${rowId}&token=${token}`));
    // The refusal is the SAME pair an unknown token gets (compared below):
    // a disable must not become an enumeration signal.
    expect(refused).toEqual({ ok: false, code: 4001, reason: "unauthorized" });
    expect(await resolveAttach(request(`subshell=${rowId}&token=not-a-token`))).toEqual(refused);
    // ...and the refusal still CONSUMED it — the ask runs after
    // `consumeWsToken`, so the wrong-scope rule's burned-token discipline
    // holds for this refusal too. (If the check ran before consuming, this
    // call would find the entry and hand back an identity.)
    expect(consumeWsToken(token)).toBeNull();

    // A SCOPED (Bearer-minted) token names the pane's OWNER as its identity,
    // so a disabled owner's machine attach is refused by the same ask — the
    // scope check passing is not a way in.
    const scoped = issueWsToken(userId, rowId);
    expect(await resolveAttach(request(`subshell=${rowId}&token=${scoped}`))).toEqual(refused);
    await setDisabled(0);
  });

  it("redeems normally once re-enabled — the flag decides, not the store", async () => {
    await setDisabled(0);
    const rowId = await ownedRow();
    const token = issueWsToken(userId);
    const out = await resolveAttach(request(`subshell=${rowId}&token=${token}`));
    expect(out.ok).toBe(true);
  });
});

describe("attachJournalLine", () => {
  it("keeps a real browser UA intact — the clamp is an allow-set, not a mangler", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
    const line = attachJournalLine("sub-1", lineParams({ size: { cols: 120, rows: 40 } }), ua);
    expect(line).toContain(`ua="${ua}"`);
    expect(line).toContain("geometry 120x40");
  });

  it("a UA cannot close the quote and forge a second `ws attach` record", () => {
    // This line is the attach forensics an operator greps (AGENTS: "the only
    // signal"). The quote is the field terminator, so a payload carrying one
    // — plus `: `, `=`, digits — reads as a SECOND record to anything that
    // parses the journal. Clamping kills the terminator: what is left is
    // inert text INSIDE the quoted field.
    const evil = 'Firefox" ws attach FAKE: geometry 999x999 build=F"}';
    const line = attachJournalLine("sub-1", lineParams(), evil);
    // The line ends with the field close: exactly the one opening quote and
    // the one closing quote survive, nothing after them.
    expect(line).toMatch(/ua="[^"]*"$/);
    expect(line.split('"').length - 1).toBe(2);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are GONE
    expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  });

  it("clamps BEFORE slicing — padding cannot spend the 90-char budget on noise", () => {
    // Slice-first kept 90 quotes and never reached the real tail; the order
    // is what lets the clamp contain an arbitrarily long attack string.
    const line = attachJournalLine("sub-1", lineParams(), `${'"'.repeat(95)}REAL`);
    expect(line).toContain('ua="REAL"');
  });

  it("ESC and CR cannot survive into the line at all", () => {
    // CR is the line-forging pair named in normalizeLabel; ESC is the ANSI
    // forgery (reposition/clear/journal colours). Both must be gone before
    // the text reaches the transport, and the rest is exact — a golden line,
    // so drift in the clamped remainder is visible too.
    const line = attachJournalLine(
      "sub-1",
      lineParams({ size: { cols: 80, rows: 24 } }),
      "ok\u001B[2K\u000Dws attach forged",
    );
    expect(line).toBe('ws attach sub-1: geometry 80x24 build=abc123 ua="ok[2Kws attach forged"');
  });
});

describe("resolveAttach", () => {
  it("admits the owner and hands back the row, access and params together", async () => {
    const row = await seedRow();
    const out = await resolveAttach(
      request(`subshell=${row.id}&token=${issueWsToken(row.userId)}&cols=120&rows=40&device=Laptop&hidden=1`),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.id).toBe(row.id);
    expect(out.access).toBe("owner");
    // WHO the socket authenticated as, handed back so the attach can stamp it
    // onto the socket — an account disable finds the open terminal by it.
    expect(out.userId).toBe(row.userId);
    // The whole params struct, not a hand-picked few — the omission class
    // this shape exists to close.
    expect(out.params).toEqual({
      size: { cols: 120, rows: 40 },
      deviceLabel: "Laptop",
      hidden: true,
      build: "MISSING",
      wireMode: "json",
    });
  });

  it("refuses with 4001 when no subshell is named", async () => {
    expect(await resolveAttach(request("token=x"))).toEqual({
      ok: false,
      code: 4001,
      reason: "missing subshell",
    });
  });

  it("refuses with 4001 for a bad token and no cookie", async () => {
    const row = await seedRow();
    expect(await resolveAttach(request(`subshell=${row.id}&token=not-a-token`))).toEqual({
      ok: false,
      code: 4001,
      reason: "unauthorized",
    });
  });

  it("burns the token: the same one cannot attach twice", async () => {
    // Single-use is the replay defence, and it belongs to this path.
    const row = await seedRow();
    const token = issueWsToken(row.userId);
    expect((await resolveAttach(request(`subshell=${row.id}&token=${token}`))).ok).toBe(true);
    expect(await resolveAttach(request(`subshell=${row.id}&token=${token}`))).toEqual({
      ok: false,
      code: 4001,
      reason: "unauthorized",
    });
  });

  it("admits a SCOPED (Bearer-minted) token on the pane it names, as the owner", async () => {
    // The identity a scoped token carries is the SUBSHELL'S OWNER, and its
    // access must resolve `owner` — if the mint had stored the actor (the
    // system service user, no admin role, no shares), this is the case that
    // would catch it: every machine attach would land on the 4005 below.
    const row = await seedRow();
    const scoped = issueWsToken(row.userId, row.id);
    const out = await resolveAttach(request(`subshell=${row.id}&token=${scoped}`));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.access).toBe("owner");
  });

  it("refuses a SCOPED token on any other subshell, identically to a bad token", async () => {
    // The binding is the containment for machine mints: an owner identity on
    // a token bound to another pane must buy nothing. The refusal is the
    // SAME pair a bad token gets (toEqual, not merely both-4001, so the two
    // cannot drift), and it burns the token — one guess per captured token,
    // never a binding oracle.
    const mine = await seedRow();
    const other = await seedRow();
    const scoped = issueWsToken(mine.userId, mine.id);
    const wrong = await resolveAttach(request(`subshell=${other.id}&token=${scoped}`));
    expect(wrong).toEqual({ ok: false, code: 4001, reason: "unauthorized" });
    expect(await resolveAttach(request(`subshell=${mine.id}&token=not-a-token`))).toEqual(wrong);
    // ...and the burned token no longer attaches even to ITS OWN pane.
    expect(await resolveAttach(request(`subshell=${mine.id}&token=${scoped}`))).toEqual(wrong);
  });

  it("tells a stranger nothing: an unshared subshell answers exactly like a missing one", async () => {
    // Absent, unshared and forbidden must be indistinguishable on the wire,
    // or ids can be probed. Asserting the two are EQUAL is the only way to
    // state that; asserting each separately would let them drift apart.
    const mine = await seedRow();
    const theirs = await seedRow();
    const stranger = issueWsToken(theirs.userId);
    const unshared = await resolveAttach(request(`subshell=${mine.id}&token=${stranger}`));
    const missing = await resolveAttach(
      request(`subshell=${crypto.randomUUID()}&token=${issueWsToken(theirs.userId)}`),
    );
    // 4005, the PERMANENT refusal (Wave D review): the 4004 family is what
    // the client retries, so "not found" needed its own code. Wire-additive:
    // a pre-Wave D client treated every non-retryable 4xxx as terminal and
    // never retried 4004, so the move changes nothing for it.
    expect(unshared).toEqual({ ok: false, code: 4005, reason: "subshell not found" });
    expect(unshared).toEqual(missing);
  });

  it("refuses the no-token path when the cookie carries no session", async () => {
    // The cookie branch exists for a same-host WS with no proxy in front. A
    // garbage cookie must land on the same 4001 a bad token does — the two
    // auth routes cannot disagree about what "not signed in" looks like.
    const row = await seedRow();
    const out = await resolveAttach({
      url: new URL(`ws://localhost/ws?subshell=${row.id}`),
      cookieHeader: "better-auth.session_token=nonsense",
      attachUa: "test-ua",
    });
    expect(out).toEqual({ ok: false, code: 4001, reason: "unauthorized" });
  });

  it("admits a `view` grantee as view, not as owner", async () => {
    // Access is what decides whether this socket may type, so resolving it to
    // the wrong level here is an authorization bug, not a display one.
    const row = await seedRow();
    const guest = `u-attach-guest-${seq}`;
    const { repos } = getRequestlessContext();
    await repos.subshellShares.replaceForSubshell(row.id, [{ granteeUserId: guest, permission: "view" }], row.userId);
    const out = await resolveAttach(request(`subshell=${row.id}&token=${issueWsToken(guest)}`));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.access).toBe("view");
  });

  it("admits an `edit` grantee as edit", async () => {
    const row = await seedRow();
    const guest = `u-attach-editor-${seq}`;
    const { repos } = getRequestlessContext();
    await repos.subshellShares.replaceForSubshell(row.id, [{ granteeUserId: guest, permission: "edit" }], row.userId);
    const out = await resolveAttach(request(`subshell=${row.id}&token=${issueWsToken(guest)}`));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.access).toBe("edit");
  });

  it("defaults every param a bare client omits", async () => {
    const row = await seedRow();
    const out = await resolveAttach(request(`subshell=${row.id}&token=${issueWsToken(row.userId)}`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.params).toEqual({
      size: null,
      deviceLabel: "Unnamed device",
      hidden: false,
      build: "MISSING",
      wireMode: "json",
    });
  });
});

describe("resolveAttach clears the unseen push (spec 2026-09-23)", () => {
  const email = `attach-unseen-${crypto.randomUUID()}@subshell.local`;
  const pw = "attach-unseen-pass-1";
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(email);
  });

  /** The owner's running row with unseen urgency 2. */
  async function unseenRow(): Promise<string> {
    const { repos } = getRequestlessContext();
    const row = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId,
      presetId: "p-test",
      harnessId: "shell",
      name: "attach-unseen",
      workingDir: "/tmp",
      tmuxSocket: "subshell-attach-unseen",
    });
    await repos.subshells.update(row.id, { lastPushUrgency: 2, alive: 1, status: "running" });
    return row.id;
  }

  const urgencyOf = async (id: string) => (await new SubshellsRepository(db).findById(id))?.lastPushUrgency;

  it("the cookie-fallback attach clears it", async () => {
    const id = await unseenRow();
    const res = await resolveAttach({
      url: new URL(`ws://localhost/ws?subshell=${id}`),
      cookieHeader: `better-auth.session_token=${cookie}`,
      attachUa: "test-ua",
    });
    expect(res.ok).toBe(true);
    expect(await urgencyOf(id)).toBeNull();
  });

  it("an UNBOUND (cookie-minted) ws-token attach clears it", async () => {
    const id = await unseenRow();
    const token = issueWsToken(userId); // subshellId null = cookie's spelling
    const res = await resolveAttach(request(`subshell=${id}&token=${token}`));
    expect(res.ok).toBe(true);
    expect(await urgencyOf(id)).toBeNull();
  });

  it("a SCOPED (Bearer-minted) token resolves as the owner but attends nothing", async () => {
    const id = await unseenRow();
    const token = issueWsToken(userId, id);
    const res = await resolveAttach(request(`subshell=${id}&token=${token}`));
    expect(res.ok).toBe(true);
    expect(await urgencyOf(id)).toBe(2);
  });
});
