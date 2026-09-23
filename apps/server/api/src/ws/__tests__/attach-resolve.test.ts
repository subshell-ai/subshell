import { beforeAll, describe, expect, it } from "bun:test";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { resolveAttach } from "@/ws/attach-resolve.js";
import { issueWsToken } from "@/ws/ws-token.js";

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
