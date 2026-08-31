import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { filesRoutes } from "@/api/files.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The folder explorer is an authenticated-BROWSER convenience, not an API:
 * machine credentials (bearer session/system keys) must not be able to walk
 * the host filesystem, and MOTE_FS_ROOT — when set — confines browsing to
 * that tree. (Unset means no confinement by design; the route docstring is
 * the contract, this pins it.)
 */
describe("files route (folder explorer)", () => {
  let userId: string;
  let cookie: string;
  const email = `files-${crypto.randomUUID()}@mote.local`;
  const password = "files-pass-1234";
  const createdSessionIds: string[] = [];
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
    for (const sid of createdSessionIds) await db.deleteFrom("sessions").where("id", "=", sid).execute();
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

  /** Creates a session row and mints its real bearer token. */
  async function mintSessionKey(): Promise<string> {
    const id = crypto.randomUUID();
    createdSessionIds.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "files-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSessionToken(id, userId);
    const row = await new SessionsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    return key;
  }

  async function mintSystemKey(): Promise<string> {
    const created = (await auth.api.createApiKey({
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

  it("session key bearer -> 403 (no filesystem walking from a harness)", async () => {
    const key = await mintSessionKey();
    expect((await explore({ bearer: key, path: "/tmp" })).status).toBe(403);
  });

  it("system key bearer -> 403 (machine credentials are not browsers)", async () => {
    const key = await mintSystemKey();
    expect((await explore({ bearer: key, path: "/tmp" })).status).toBe(403);
  });

  describe("MOTE_FS_ROOT confinement", () => {
    // The route reads the env per request, so setting it around these tests
    // is enough; the cookie request helper goes through the same handler.
    const confined = Bun.spawnSync(["mktemp", "-d", "/tmp/mote-fsroot-XXXXXX"]);
    const rootDir = confined.stdout.toString().trim();
    let saved: string | undefined;

    beforeAll(() => {
      saved = process.env.MOTE_FS_ROOT;
      process.env.MOTE_FS_ROOT = rootDir;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.MOTE_FS_ROOT;
      else process.env.MOTE_FS_ROOT = saved;
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
      const outside = mkdtempSync(join(tmpdir(), "mote-fsroot-outside-"));
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
      await repo.touch(userId, "/tmp/older", "old session");
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
      const key = await mintSessionKey();
      expect((await recent({ bearer: key })).status).toBe(403);
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
      const key = await mintSessionKey();
      expect((await favorite({ bearer: key, path: "/tmp/x", on: true })).status).toBe(403);
      expect((await favorite({ path: "/tmp/x", on: true })).status).toBe(401);
    });

    it("path outside MOTE_FS_ROOT confinement -> 403", async () => {
      const saved = process.env.MOTE_FS_ROOT;
      process.env.MOTE_FS_ROOT = "/opt/mote-root";
      try {
        expect((await favorite({ cookieToken: cookie, path: "/etc", on: true })).status).toBe(403);
      } finally {
        if (saved === undefined) delete process.env.MOTE_FS_ROOT;
        else process.env.MOTE_FS_ROOT = saved;
      }
    });
  });
});
