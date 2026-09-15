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
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * GET /api/subshells/:id/log — the diagnostic tail a dead subshell's pane
 * leaves behind. The WS refuses dead panes and `preview` is empty for them,
 * so this file's tail is the only witness of why a harness exited.
 */
describe("GET /api/subshells/:id/log", () => {
  let userId: string;
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

  async function newSubshell(): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
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
    const otherId = await new UsersRepository(db).createUser({
      email: otherEmail,
      name: otherEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    otherToken = await signIn(otherEmail, pw);
    void otherId;
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
    expect((await res.json()) as { lines: string[]; truncated: boolean }).toEqual({
      lines: [],
      truncated: false,
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
});
