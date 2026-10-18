import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { spawnSync } from "bun";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The workspace half of the subshell door (spec 2026-10-17): filing a create
 * as a tab (`workspaceId`), the Ungrouped read (`?workspace=none`), and the
 * empty-retire that follows a subshell delete. The workspaces surface itself
 * is pinned in `api/workspaces/__tests__/workspaces-route.test.ts`; this is
 * the seam between the two, on the door bearer tokens already walk through.
 */
const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

describe("subshell ↔ workspace filing", () => {
  const pw = "wsfile-pass-1";
  const email = `wsfile-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `wsfile-o-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let otherId: string;
  let cookie: string;
  let claudePresetId: string;
  let ownWorkspaceId: string;
  let foreignWorkspaceId: string;
  const createdSubshellIds: string[] = [];
  const sockets = new Set<string>();
  const testDir = mkdtempSync(join(tmpdir(), "subshell-wsfile-"));

  const workspaces = new WorkspacesRepository(db);
  const panes = new WorkspacePanesRepository(db);

  /** Inserts a subshell row directly (no launch) and returns its id. */
  async function makeSubshellRow(owner: string): Promise<string> {
    const id = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id,
      userId: owner,
      presetId: null,
      harnessId: "claude-code",
      name: `row-${id.slice(0, 8)}`,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push(id);
    return id;
  }

  /** GETs with the test user's cookie. */
  function get(path: string) {
    return app.fetch(
      new Request(`http://localhost:3080${path}`, { headers: { cookie: `better-auth.session_token=${cookie}` } }),
    );
  }

  beforeAll(async () => {
    await setupAuthTables();
    await ensureLocalNode(db);
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    otherId = await new UsersRepository(db).createUser({
      email: otherEmail,
      name: otherEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    claudePresetId = (
      await new PresetsRepository(db).create({
        id: crypto.randomUUID(),
        userId,
        harnessId: "claude-code",
        name: `p-${crypto.randomUUID().slice(0, 8)}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
      })
    ).id;
    ownWorkspaceId = (await workspaces.create({ id: crypto.randomUUID(), userId, name: "Mine" })).id;
    foreignWorkspaceId = (await workspaces.create({ id: crypto.randomUUID(), userId: otherId, name: "Theirs" })).id;
  });

  afterAll(async () => {
    for (const id of createdSubshellIds) await new SubshellsRepository(db).delete(id).catch(() => {});
    await db.deleteFrom("workspacePanes").execute();
    await db.deleteFrom("workspaces").execute();
    await db.deleteFrom("presets").where("userId", "=", userId).execute();
    await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
    for (const socket of sockets) {
      spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    }
    rmSync(testDir, { recursive: true, force: true });
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(otherEmail);
  });

  describe("GET /api/subshells?workspace=", () => {
    it("separates ungrouped from filed, per the CALLER'S workspaces", async () => {
      const filed = await makeSubshellRow(userId);
      const loose = await makeSubshellRow(userId);
      await panes.create({ id: crypto.randomUUID(), workspaceId: ownWorkspaceId, subshellId: filed });

      const none = (await (await get("/api/subshells?workspace=none")).json()) as { id: string }[];
      expect(none.map((s) => s.id)).toContain(loose);
      expect(none.map((s) => s.id)).not.toContain(filed);

      const members = (await (await get(`/api/subshells?workspace=${ownWorkspaceId}`)).json()) as { id: string }[];
      expect(members.map((s) => s.id)).toEqual([filed]);

      // An id you do not own answers empty, not 403/404: the list never
      // confirms whose workspace is whose (same posture as nodeId).
      const foreign = await get(`/api/subshells?workspace=${foreignWorkspaceId}`);
      expect(foreign.status).toBe(200);
      expect(((await foreign.json()) as unknown[]).length).toBe(0);
    });

    it("refuses shapes at the boundary, including the Unicode a real search box can carry", async () => {
      // `;` is the SQL-injection-shaped value; regex characters are the other.
      for (const value of ["no;ne", "none*", "none​", "x".repeat(129)]) {
        const res = await get(`/api/subshells?${new URLSearchParams({ workspace: value })}`);
        expect(res.status).toBe(400);
      }
      // "none" itself and a plain uuid-shaped id are both legal.
      expect((await get("/api/subshells?workspace=none")).status).toBe(200);
    });

    // The filter reads membership BEFORE the visibility resolver runs, so the
    // door's own posture needs pinning on both filter shapes (spec 2026-10-17
    // Testing; .claude/rules/testing.md: new filters retain anonymous and
    // scoped-bearer checks). The guard, not the filter, is what answers these.
    it("is 401 for an anonymous caller on every filter shape", async () => {
      for (const path of ["/api/subshells?workspace=none", `/api/subshells?workspace=${ownWorkspaceId}`]) {
        const res = await app.fetch(new Request(`http://localhost:3080${path}`));
        expect(res.status).toBe(401);
      }
    });

    it("answers a subshell's own token exactly as its owner's cookie (the list-visibility ruling)", async () => {
      // One filed row and one loose row, so both filters have something to
      // separate; the pairs compared below are cookie vs bearer on the SAME
      // database state. A pane token resolves to its owner with shares and
      // admin off — for this owner's own rows that is the identical answer,
      // and the filter must not move that line (review 2026-10-17: the shape
      // tests pinned the parsing, nobody had pinned the posture).
      const tokenRow = await makeSubshellRow(userId);
      const key = await issueSubshellToken(tokenRow, userId);
      const bearer = (path: string) =>
        app.fetch(new Request(`http://localhost:3080${path}`, { headers: { authorization: `Bearer ${key}` } }));
      const ids = (res: Response) => res.json().then((rows) => (rows as { id: string }[]).map((s) => s.id).sort());

      for (const path of ["/api/subshells?workspace=none", `/api/subshells?workspace=${ownWorkspaceId}`]) {
        const asCookie = await get(path);
        const asToken = await bearer(path);
        expect(asToken.status).toBe(200);
        expect(await ids(asToken)).toEqual(await ids(asCookie));
      }
    });
  });

  describe("POST /api/subshells with workspaceId", () => {
    /** Set by the successful-create test; read by the empty-retire test. */
    let filedSubshellId: string;

    it("another user's workspace is a 404 before anything spawns", async () => {
      const res = await app.fetch(
        new Request("http://localhost:3080/api/subshells", {
          method: "POST",
          headers: { cookie: `better-auth.session_token=${cookie}`, "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "claude-code",
            presetId: claudePresetId,
            workingDir: "/tmp",
            workspaceId: foreignWorkspaceId,
          }),
        }),
      );
      expect(res.status).toBe(404);
      // No membership row for the foreign workspace was written, either.
      expect(await panes.listMembershipForUser(otherId)).toHaveLength(0);
    });

    /** The filing pair runs on its own workspace so membership counts are exact. */
    let filingWorkspaceId: string;

    it("a successful create lands as a tab in the named workspace", async () => {
      filingWorkspaceId = (await workspaces.create({ id: crypto.randomUUID(), userId, name: "Filing" })).id;
      const stub = join(testDir, "claude-stub");
      writeFileSync(stub, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
      const prev = process.env.CLAUDE_PATH;
      process.env.CLAUDE_PATH = stub;
      try {
        const res = await app.fetch(
          new Request("http://localhost:3080/api/subshells", {
            method: "POST",
            headers: { cookie: `better-auth.session_token=${cookie}`, "content-type": "application/json" },
            body: JSON.stringify({
              harnessId: "claude-code",
              presetId: claudePresetId,
              workingDir: "/tmp",
              name: "filed-pane",
              workspaceId: filingWorkspaceId,
            }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string; tmuxSocket: string };
        createdSubshellIds.push(body.id);
        sockets.add(body.tmuxSocket);
        filedSubshellId = body.id;

        const membership = await panes.listMembershipForUser(userId);
        expect(membership).toContainEqual({ workspaceId: filingWorkspaceId, subshellId: body.id });

        // The Ungrouped read no longer carries it.
        const none = (await (await get("/api/subshells?workspace=none")).json()) as { id: string }[];
        expect(none.map((s) => s.id)).not.toContain(body.id);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PATH;
        else process.env.CLAUDE_PATH = prev;
      }
    });

    it("deleting the subshell retires the workspace its tab just emptied", async () => {
      // Continues from the 200 above: the filing workspace holds exactly this
      // one tab, so deleting the pane's row empties and retires it.
      const res = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${filedSubshellId}`, {
          method: "DELETE",
          headers: { cookie: `better-auth.session_token=${cookie}` },
        }),
      );
      expect(res.status).toBe(200);

      expect(await workspaces.findByIdForUser(filingWorkspaceId, userId)).toBeUndefined();
      expect(await panes.listMembershipForUser(userId)).not.toContainEqual({
        workspaceId: filingWorkspaceId,
        subshellId: filedSubshellId,
      });
    });
  });
});
