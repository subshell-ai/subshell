import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * GET /api/subshells/:id/log — the diagnostic tail a dead subshell's pane
 * leaves behind. The WS refuses dead panes and `preview` is empty for them,
 * so this file's tail is the only witness of why a harness exited.
 */
describe("GET /api/subshells/:id/log", () => {
  let userId: string;
  let otherUserId: string;
  let token: string;
  let otherToken: string;
  const email = `log-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `log2-${crypto.randomUUID()}@subshell.local`;
  const pw = "log-pass-1";
  const createdSubshells: string[] = [];

  function writeLog(id: string, content: string) {
    const file = subshellLogPath(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  async function newSubshell(ownerId: string = userId): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId: ownerId,
      presetId: "p",
      harnessId: "claude-code",
      name: "log-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    token = await signIn(email, pw);
    otherUserId = await new UsersRepository(db).createUser({
      email: otherEmail,
      name: otherEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    otherToken = await signIn(otherEmail, pw);
  });

  afterAll(async () => {
    for (const id of createdSubshells) {
      rmSync(subshellLogPath(id), { force: true });
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    }
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(otherEmail);
  });

  it("returns the tail lines of the subshell log, ANSI stripped", async () => {
    const id = await newSubshell();
    writeLog(id, "line one\n[31mred error[39m\nlast line\n");
    const res = await subshellRoutes.fetch(authedRequest(`/api/subshells/${id}/log`, token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[]; truncated: boolean };
    expect(body.lines).toEqual(["line one", "red error", "last line"]);
    expect(body.truncated).toBe(false);
  });

  it("returns an empty tail when no log exists yet", async () => {
    const id = await newSubshell();
    const res = await subshellRoutes.fetch(authedRequest(`/api/subshells/${id}/log`, token));
    expect(res.status).toBe(200);
    // Deliberate shape change (spec 2026-10-01 §3): every response now carries
    // nextByte, so an empty log seeds a cursor at 0.
    expect((await res.json()) as { lines: string[]; truncated: boolean; nextByte: number }).toEqual({
      lines: [],
      truncated: false,
      nextByte: 0,
    });
  });

  it("keeps the last 200 lines and flags truncation", async () => {
    const id = await newSubshell();
    writeLog(id, Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n"));
    const res = await subshellRoutes.fetch(authedRequest(`/api/subshells/${id}/log`, token));
    const body = (await res.json()) as { lines: string[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.lines.length).toBe(200);
    expect(body.lines.at(-1)).toBe("line 249");
    expect(body.lines[0]).toBe("line 50");
  });

  it("another user's subshell is 404, not 403 — same shape as GET /:id", async () => {
    const id = await newSubshell();
    const res = await subshellRoutes.fetch(authedRequest(`/api/subshells/${id}/log`, otherToken));
    expect(res.status).toBe(404);
  });

  it("anonymous -> 401", async () => {
    const res = await subshellRoutes.fetch(new Request(`http://localhost:3080/api/subshells/any/log`));
    expect(res.status).toBe(401);
  });

  it("SUBSHELL_SERVER_DATA_DIR is absolute — the log path must survive any cwd", () => {
    // The pane log's directory travels to tmux and harness processes; a
    // relative path silently reads from the wrong cwd.
    expect(SUBSHELL_SERVER_DATA_DIR.startsWith("/")).toBe(true);
  });

  /**
   * THE BEARER DOOR for the MCP `read_subshell_log` tool (spec 2026-09-25,
   * MCP DX): the gate at `view` with the machineActor rules already resolves a
   * pane token as its owner with shares switched off, so a SIBLING of the same
   * owner reads the tail and a foreign row is a 404, never a 403. This test
   * exists so that door cannot close silently: the tool lands in a later task,
   * and nothing else on this path pins it for a bearer actor.
   */
  describe("bearer door (a pane's own token)", () => {
    let paneKey: string;

    beforeAll(async () => {
      const own = await newSubshell(); // the pane the token authenticates
      paneKey = await issueSubshellToken(own, userId);
    });

    function bearerGet(id: string) {
      return subshellRoutes.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/log`, {
          headers: { authorization: `Bearer ${paneKey}` },
        }),
      );
    }

    it("a sibling subshell of the SAME owner reads 200 with the tail shape", async () => {
      const sibling = await newSubshell();
      writeLog(sibling, "sibling says hello\nsecond line\n");
      const res = await bearerGet(sibling);
      expect(res.status).toBe(200);
      // nextByte = 31 is the raw byte length of the written log: the tail's
      // cursor seeds at EOF (spec 2026-10-01 §3, deliberate shape change).
      expect((await res.json()) as { lines: string[]; truncated: boolean; nextByte: number }).toEqual({
        lines: ["sibling says hello", "second line"],
        truncated: false,
        nextByte: 31,
      });
    });

    it("a foreign user's row is 404, not 403: the owner-only bearer rule survives the door", async () => {
      const foreign = await newSubshell(otherUserId);
      writeLog(foreign, "not yours\n");
      expect((await bearerGet(foreign)).status).toBe(404);
    });
  });

  /**
   * The byte cursor (spec 2026-10-01 §3): the MCP read loop is
   * tail-seeds-nextByte, then read(from_byte = nextByte) forever. Each rule
   * here is the failure mode that loop would have: dup, skip, split lines, or
   * a stuck cursor.
   */
  describe("cursor reads (from_byte / max_bytes)", () => {
    async function getCursor(
      id: string,
      qs: Record<string, string | number>,
    ): Promise<{ status: number; body: { lines: string[]; truncated: boolean; nextByte: number } }> {
      const url = `/api/subshells/${id}/log?${new URLSearchParams(
        Object.entries(qs).map(([k, v]) => [k, String(v)] as [string, string]),
      )}`;
      const res = await subshellRoutes.fetch(authedRequest(url, token));
      return { status: res.status, body: (await res.json()) as never };
    }

    it("resumes at a line boundary: no dup, no skip across a split", async () => {
      const id = await newSubshell();
      writeLog(id, "alpha\nbravo\ncharlie\n");
      // max_bytes=8 cuts through "bravo": only the newline-terminated line is consumed.
      const first = await getCursor(id, { from_byte: 0, max_bytes: 8 });
      expect(first.body.lines).toEqual(["alpha"]);
      expect(first.body.nextByte).toBe(6);
      expect(first.body.truncated).toBe(true);
      const second = await getCursor(id, { from_byte: first.body.nextByte });
      expect(second.body.lines).toEqual(["bravo", "charlie"]);
      expect(second.body.nextByte).toBe(20);
      expect(second.body.truncated).toBe(false);
    });

    it("a tail read seeds the cursor at EOF and appends then come through", async () => {
      const id = await newSubshell();
      writeLog(id, "one\n");
      const tail = await getCursor(id, {});
      expect(tail.body.nextByte).toBe(4);
      writeLog(id, "one\ntwo\n");
      const next = await getCursor(id, { from_byte: tail.body.nextByte });
      expect(next.body.lines).toEqual(["two"]);
      expect(next.body.nextByte).toBe(8);
      expect(next.body.truncated).toBe(false);
    });

    it("from_byte past EOF answers empty and parks the cursor at size", async () => {
      const id = await newSubshell();
      writeLog(id, "x\n");
      const res = await getCursor(id, { from_byte: 50 });
      expect(res.body).toEqual({ lines: [], truncated: false, nextByte: 2 });
    });

    it("a single line longer than the window is returned partial and the cursor advances (liveness)", async () => {
      const id = await newSubshell();
      writeLog(id, "A".repeat(25));
      const first = await getCursor(id, { from_byte: 0, max_bytes: 10 });
      expect(first.body.lines).toEqual(["AAAAAAAAAA"]);
      expect(first.body.truncated).toBe(true);
      expect(first.body.nextByte).toBe(10); // the loop MOVES: a stuck cursor here would spin forever
      const second = await getCursor(id, { from_byte: 10, max_bytes: 10 });
      expect(second.body.nextByte).toBe(20);
      const third = await getCursor(id, { from_byte: 20, max_bytes: 10 });
      expect(third.body.lines).toEqual(["AAAAA"]);
      expect(third.body.nextByte).toBe(25);
    });

    it("ANSI is stripped from lines while nextByte stays the RAW offset", async () => {
      const id = await newSubshell();
      const content = "[31mred[39m\nplain\n";
      writeLog(id, content);
      const res = await getCursor(id, { from_byte: 0 });
      expect(res.body.lines).toEqual(["red", "plain"]);
      expect(res.body.nextByte).toBe(Buffer.byteLength(content)); // raw bytes, not stripped-text length
    });

    it("out-of-range windows CLAMP like every numeric surface here, never refuse", async () => {
      const id = await newSubshell();
      writeLog(id, "data\n");
      // Negative offset reads as 0.
      const neg = await getCursor(id, { from_byte: -1 });
      expect(neg.body.lines).toEqual(["data"]);
      // A zero budget clamps to 1 byte: the window holds no newline, so the
      // liveness rule fires - the partial line IS shown and the cursor DOES
      // advance (a held cursor here would spin the loop forever).
      const tiny = await getCursor(id, { max_bytes: 0, from_byte: 0 });
      expect(tiny.body).toEqual({ lines: ["d"], truncated: true, nextByte: 1 });
      // A fractional offset truncates rather than 400s (the clamp doctrine;
      // t.Numeric coercion, Math.trunc in readLogCursor).
      const frac = await getCursor(id, { from_byte: 3.9 });
      expect(frac.body.lines).toEqual(["a"]);
      expect(frac.body.nextByte).toBe(5);
      // An oversized budget clamps to the window ceiling and still reads fine.
      const big = await getCursor(id, { max_bytes: 10_000_000, from_byte: 0 });
      expect(big.body.nextByte).toBe(5);
    });
  });
});
