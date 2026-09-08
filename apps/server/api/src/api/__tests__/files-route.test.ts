import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { filesRoutes } from "@/api/files.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The folder explorer is an authenticated-BROWSER convenience, not an API:
 * machine credentials (bearer subshell/system keys) must not be able to walk
 * the host filesystem, and SUBSHELL_FS_ROOT — when set — confines browsing to
 * that tree. (Unset means no confinement by design; the route docstring is
 * the contract, this pins it.)
 */
describe("files route (folder explorer)", () => {
  let userId: string;
  let cookie: string;
  const email = `files-${crypto.randomUUID()}@subshell.local`;
  const password = "files-pass-1234";
  const createdSubshellIds: string[] = [];
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
  });

  afterAll(async () => {
    for (const sid of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", sid).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await deleteUserByEmailOrId(email);
  });

  async function explore(opts: { cookieToken?: string; bearer?: string; path?: string }) {
    const url = `http://localhost:3080/api/files/explore${opts.path !== undefined ? `?path=${encodeURIComponent(opts.path)}` : ""}`;
    const headers = new Headers();
    if (opts.cookieToken) headers.set("cookie", `better-auth.session_token=${opts.cookieToken}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    return filesRoutes.fetch(new Request(url, { headers }));
  }

  /** Creates a subshell row and mints its real bearer token. */
  async function mintSubshellKey(): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "files-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(id, userId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    return key;
  }

  async function mintSystemKey(): Promise<string> {
    const created = (await getAuth().api.createApiKey({
      body: { name: "files-test-system", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    return created.key;
  }

  it("cookie actor browses (200) with an entries list", async () => {
    const res = await explore({ cookieToken: cookie, path: "/tmp" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: unknown[] };
    expect(body.path).toBe("/tmp");
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("anonymous -> 401", async () => {
    expect((await explore({})).status).toBe(401);
  });

  it("subshell key bearer -> 403 (no filesystem walking from a harness)", async () => {
    const key = await mintSubshellKey();
    expect((await explore({ bearer: key, path: "/tmp" })).status).toBe(403);
  });

  it("system key bearer -> 403 (machine credentials are not browsers)", async () => {
    const key = await mintSystemKey();
    expect((await explore({ bearer: key, path: "/tmp" })).status).toBe(403);
  });

  describe("SUBSHELL_FS_ROOT confinement", () => {
    // The route reads the env per request, so setting it around these tests
    // is enough; the cookie request helper goes through the same handler.
    const confined = Bun.spawnSync(["mktemp", "-d", "/tmp/subshell-fsroot-XXXXXX"]);
    const rootDir = confined.stdout.toString().trim();
    let saved: string | undefined;

    beforeAll(() => {
      saved = process.env.SUBSHELL_FS_ROOT;
      process.env.SUBSHELL_FS_ROOT = rootDir;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.SUBSHELL_FS_ROOT;
      else process.env.SUBSHELL_FS_ROOT = saved;
    });

    it("path outside the root -> 403", async () => {
      expect((await explore({ cookieToken: cookie, path: "/tmp" })).status).toBe(403);
    });

    it("path inside the root -> 200", async () => {
      const res = await explore({ cookieToken: cookie, path: rootDir });
      expect(res.status).toBe(200);
    });

    it("dot-dot traversal cannot escape the root", async () => {
      expect((await explore({ cookieToken: cookie, path: `${rootDir}/../..` })).status).toBe(403);
    });

    it("a symlink inside the root cannot carry the browse outside it", async () => {
      // M-2 (final review): confinement compared unresolved paths while the
      // entry stat follows symlinks — clicking a planted symlink dir listed
      // its target anywhere on the host. Must now compare realpath forms.
      const outside = mkdtempSync(join(tmpdir(), "subshell-fsroot-outside-"));
      writeFileSync(join(outside, "secret-outside.txt"), "leaked");
      const link = join(rootDir, "escape-link");
      try {
        symlinkSync(outside, link);
        // Pre-fix this returned 200 and listed secret-outside.txt.
        const res = await explore({ cookieToken: cookie, path: link });
        expect(res.status).toBe(403);
        // Listing the root itself must also not hand out a browsable escape:
        // the entry may appear, but following it is refused (asserted above).
      } finally {
        rmSync(link, { force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("a broken symlink inside the root is refused, not 500", async () => {
      const dangling = join(rootDir, "dangling-link");
      try {
        symlinkSync(join(rootDir, "does-not-exist"), dangling);
        expect((await explore({ cookieToken: cookie, path: dangling })).status).toBe(403);
      } finally {
        rmSync(dangling, { force: true });
      }
    });
  });

  describe("GET /api/files/recent", () => {
    /** Fetches the caller's recent paths. */
    async function recent(opts: { cookieToken?: string; bearer?: string } = {}) {
      const headers = new Headers();
      if (opts.cookieToken) headers.set("cookie", `better-auth.session_token=${opts.cookieToken}`);
      if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
      return filesRoutes.fetch(new Request("http://localhost:3080/api/files/recent", { headers }));
    }

    it("lists the user's recorded paths newest-first", async () => {
      const repo = new RecentPathsRepository(db);
      await repo.touch(userId, "/tmp/older", "old subshell");
      await repo.touch(userId, "/tmp/newer", null);
      const res = await recent({ cookieToken: cookie });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { paths: { path: string }[] };
      expect(body.paths.map((p) => p.path).slice(0, 2)).toEqual(["/tmp/newer", "/tmp/older"]);
      await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
    });

    it("unauthenticated -> 401", async () => {
      expect((await recent()).status).toBe(401);
    });

    it("machine bearer -> 403 (browser affordance, like /explore)", async () => {
      const key = await mintSubshellKey();
      expect((await recent({ bearer: key })).status).toBe(403);
    });

    describe("per-node scoping (recent paths are per-machine)", () => {
      const nodes = new NodesRepository(db);
      const repo = new RecentPathsRepository(db);
      /** A node the test user OWNS → visible (owner access). */
      let ownNodeId: string;
      /** A node owned by a ghost id with no shares → invisible, like a foreign one. */
      let foreignNodeId: string;
      const SHARED_PATH = "/tmp/subshell-recent-two-nodes";

      async function recentScoped(node?: string) {
        const url = `http://localhost:3080/api/files/recent${node !== undefined ? `?node=${encodeURIComponent(node)}` : ""}`;
        return filesRoutes.fetch(new Request(url, { headers: { cookie: `better-auth.session_token=${cookie}` } }));
      }

      beforeAll(async () => {
        ownNodeId = crypto.randomUUID();
        await nodes.create({
          id: ownNodeId,
          ownerUserId: userId,
          name: `recent-${ownNodeId}`,
          kind: "agent",
          status: "offline",
        });
        // owner_user_id carries no FK; a ghost owner is exactly a private
        // foreign node from this viewer's seat: access "none", never 403.
        foreignNodeId = crypto.randomUUID();
        await nodes.create({
          id: foreignNodeId,
          ownerUserId: `ghost-${crypto.randomUUID()}`,
          name: `recent-${foreignNodeId}`,
          kind: "agent",
          status: "offline",
        });
      });

      afterEach(async () => {
        await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
      });

      afterAll(async () => {
        await nodes.deleteById(ownNodeId);
        await nodes.deleteById(foreignNodeId);
      });

      it("a path used on node X surfaces for ?node=X and NOT for omitted or local", async () => {
        // Same touch a subshell-create on node X performs (the write site now
        // carries the resolved node — pinned end-to-end in
        // subshells-create-nodeid.test.ts).
        await repo.touch(userId, "/tmp/remote-only", "on-x", ownNodeId);
        const onX = (await (await recentScoped(ownNodeId)).json()) as { paths: { path: string }[] };
        expect(onX.paths.map((p) => p.path)).toContain("/tmp/remote-only");

        for (const localish of [await recentScoped(), await recentScoped("local")]) {
          expect(localish.status).toBe(200);
          const body = (await localish.json()) as { paths: { path: string }[] };
          expect(body.paths.map((p) => p.path)).not.toContain("/tmp/remote-only");
        }
      });

      it("omitted and ?node=local are the same list — local rows only, unchanged from today", async () => {
        await repo.touch(userId, "/tmp/local-a", null);
        await repo.touch(userId, "/tmp/local-b", null);
        await repo.touch(userId, "/tmp/remote-b", null, ownNodeId);
        const omitted = (await (await recentScoped()).json()) as { paths: { path: string; label: string | null }[] };
        const explicit = (await (await recentScoped("local")).json()) as {
          paths: { path: string; label: string | null }[];
        };
        expect(explicit.paths).toEqual(omitted.paths);
        expect(new Set(omitted.paths.map((p) => p.path))).toEqual(new Set(["/tmp/local-a", "/tmp/local-b"]));
      });

      it("the same path on two nodes is TWO entries — the (user, node, path) upsert keeps them apart", async () => {
        await repo.touch(userId, SHARED_PATH, "local label");
        await repo.touch(userId, SHARED_PATH, "node label", ownNodeId);
        // Re-touch the local triple: it must update the local row, never
        // collide with or overwrite the node row (this is the feature's point).
        await repo.touch(userId, SHARED_PATH, "relabeled local");

        const rows = await db
          .selectFrom("recentPaths")
          .select(["path", "nodeId", "label"])
          .where("userId", "=", userId)
          .where("path", "=", SHARED_PATH)
          .execute();
        expect(rows).toHaveLength(2);
        const local = (await (await recentScoped()).json()) as { paths: { path: string; label: string | null }[] };
        const onX = (await (await recentScoped(ownNodeId)).json()) as {
          paths: { path: string; label: string | null }[];
        };
        expect(local.paths).toEqual([{ path: SHARED_PATH, label: "relabeled local" }]);
        expect(onX.paths).toEqual([{ path: SHARED_PATH, label: "node label" }]);
      });

      it("invisible or unknown node -> 404 (never 403 — recents are no node-id oracle)", async () => {
        expect((await recentScoped(foreignNodeId)).status).toBe(404);
        expect((await recentScoped(crypto.randomUUID())).status).toBe(404);
      });
    });
  });

  describe("PATCH /api/files/favorite + explore sections", () => {
    /** Stars/unstars a path. */
    async function favorite(opts: { cookieToken?: string; bearer?: string; path: string; on: boolean }) {
      const headers = new Headers({ "content-type": "application/json" });
      if (opts.cookieToken) headers.set("cookie", `better-auth.session_token=${opts.cookieToken}`);
      if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
      return filesRoutes.fetch(
        new Request("http://localhost:3080/api/files/favorite", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ path: opts.path, favorite: opts.on }),
        }),
      );
    }

    afterEach(async () => {
      await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
      await db.deleteFrom("favorites").where("userId", "=", userId).execute();
    });

    it("starring a fresh path inserts it; /explore lists it under favorites", async () => {
      const res = await favorite({ cookieToken: cookie, path: "/tmp/starred", on: true });
      expect(res.status).toBe(200);
      const exploreRes = await explore({ cookieToken: cookie, path: "/tmp" });
      const body = (await exploreRes.json()) as {
        recent: { path: string }[];
        favorites: { path: string }[];
      };
      expect(body.favorites.map((f) => f.path)).toContain("/tmp/starred");
      // A path is listed once — favorites win over recents.
      expect(body.recent.map((r) => r.path)).not.toContain("/tmp/starred");
    });

    it("starring a known recent shows it only under favorites", async () => {
      const repo = new RecentPathsRepository(db);
      await repo.touch(userId, "/tmp/known", "my label");
      expect((await favorite({ cookieToken: cookie, path: "/tmp/known", on: true })).status).toBe(200);
      const body = (await (await explore({ cookieToken: cookie, path: "/tmp" })).json()) as {
        recent: { path: string }[];
        favorites: { path: string; label: string | null }[];
      };
      // The two systems are independent rows: the recent entry keeps its
      // label where it is, and the favorite appears exactly once.
      expect(body.recent.map((r) => r.path)).not.toContain("/tmp/known");
      expect(body.favorites.map((f) => f.path)).toEqual(["/tmp/known"]);
    });

    it("unstarring returns a used path to the recent section (the tables are independent)", async () => {
      // Favoriting is a favorites-table row only — it never invents a
      // recent_paths row. The unstarred path reappears under Recent solely
      // because it was ALSO used, which is what touch records.
      await new RecentPathsRepository(db).touch(userId, "/tmp/toggled", null);
      await favorite({ cookieToken: cookie, path: "/tmp/toggled", on: true });
      await favorite({ cookieToken: cookie, path: "/tmp/toggled", on: false });
      const body = (await (await explore({ cookieToken: cookie, path: "/tmp" })).json()) as {
        recent: { path: string }[];
        favorites: { path: string }[];
      };
      expect(body.favorites.map((f) => f.path)).not.toContain("/tmp/toggled");
      expect(body.recent.map((r) => r.path)).toContain("/tmp/toggled");
    });

    it("machine bearer -> 403; unauthenticated -> 401", async () => {
      const key = await mintSubshellKey();
      expect((await favorite({ bearer: key, path: "/tmp/x", on: true })).status).toBe(403);
      expect((await favorite({ path: "/tmp/x", on: true })).status).toBe(401);
    });

    it("path outside SUBSHELL_FS_ROOT confinement -> 403", async () => {
      const saved = process.env.SUBSHELL_FS_ROOT;
      process.env.SUBSHELL_FS_ROOT = "/opt/subshell-root";
      try {
        expect((await favorite({ cookieToken: cookie, path: "/etc", on: true })).status).toBe(403);
      } finally {
        if (saved === undefined) delete process.env.SUBSHELL_FS_ROOT;
        else process.env.SUBSHELL_FS_ROOT = saved;
      }
    });
  });
});
