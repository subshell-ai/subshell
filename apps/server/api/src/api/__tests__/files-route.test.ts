import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { filesRoutes, setFilesReaddirForTests } from "@/api/files.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { FavoritesRepository } from "@/db/repositories/favorites.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { setFilesRealpathForTests } from "@/services/files-path-rules.js";
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
      name: email,
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
      presetId: "p",
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

  /**
   * macOS asks per protected folder (Desktop, Documents, Downloads) the first
   * time something lists it, and a decline makes `readdir` throw EPERM forever
   * after. That is a folder the picker must still be able to SHOW — the person
   * can fix it — so the LISTING carries the flag and the panel stays open. The
   * error is injected through the route's readdir seam rather than produced
   * with `chmod`: CI runs as root, which ignores permission bits.
   */
  describe("a listing macOS refuses (spec 2026-09-14 §5.3)", () => {
    afterEach(() => setFilesReaddirForTests(null));

    /** The exact shape node throws for a TCC refusal / a mode-denied read.
     *  Rejected (not thrown): the read is async now, off the event loop. */
    function errnoThrower(code: string): (path: string) => Promise<string[]> {
      return () => {
        const err = new Error(`${code}: permission denied`) as NodeJS.ErrnoException;
        err.code = code;
        return Promise.reject(err);
      };
    }

    for (const code of ["EPERM", "EACCES"]) {
      it(`${code} on the requested path -> 200, no entries, blocked: "permission"`, async () => {
        setFilesReaddirForTests(errnoThrower(code));
        const res = await explore({ cookieToken: cookie, path: "/tmp" });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: unknown[]; blocked?: string; path: string };
        expect(body.blocked).toBe("permission");
        expect(body.entries).toEqual([]);
        // The rest of the listing still answers, so the picker can offer the
        // parent, the recents and the favorites while this folder is refused.
        expect(body.path).toBe("/tmp");
      });
    }

    it("an empty directory carries no blocked flag — the two stay distinguishable", async () => {
      const empty = mkdtempSync(join(tmpdir(), "subshell-empty-"));
      try {
        const res = await explore({ cookieToken: cookie, path: empty });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: unknown[]; blocked?: string };
        expect(body.entries).toEqual([]);
        expect(body.blocked).toBeUndefined();
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("an absent path still 404s — it is not a blocked listing", async () => {
      const res = await explore({
        cookieToken: cookie,
        path: join(tmpdir(), `subshell-absent-${crypto.randomUUID()}`),
      });
      expect(res.status).toBe(404);
    });

    it("any other readdir failure is still 403 unreadable", async () => {
      setFilesReaddirForTests(errnoThrower("EIO"));
      expect((await explore({ cookieToken: cookie, path: "/tmp" })).status).toBe(403);
    });

    it("children are never probed for permission — one readdir per request", async () => {
      // A readdir of each child is exactly the act that fires one TCC prompt
      // per folder under ~, which is why the flag is on the listing.
      const seen: string[] = [];
      setFilesReaddirForTests((path) => {
        seen.push(path);
        return Promise.resolve([]);
      });
      await explore({ cookieToken: cookie, path: "/tmp" });
      expect(seen).toEqual(["/tmp"]);
    });
  });

  // The browse reads moved off the event loop (mac-builder, 2026-09-30: one
  // SYNCHRONOUS readdir of a directory on a hung mount parked the whole server).
  // These pin the two visible consequences, both of which the picker relies on.
  describe("listing is ordered, and a hung read recovers (2026-09-30)", () => {
    afterEach(() => {
      setFilesReaddirForTests(null);
      setFilesRealpathForTests(null);
    });

    it("sorts entries alphabetically (case-insensitive, numeric-aware), not readdir order", async () => {
      const dir = mkdtempSync(join(tmpdir(), "subshell-sort-"));
      try {
        // Created deliberately out of order, and with digit runs so a naive
        // byte sort would put "item10" before "item2".
        for (const name of ["zeta", "beta", "item10", "item2", "Alpha"]) {
          mkdirSync(join(dir, name));
        }
        const res = await explore({ cookieToken: cookie, path: dir });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: { name: string; kind: string }[] };
        expect(body.entries.map((e) => e.name)).toEqual(["Alpha", "beta", "item2", "item10", "zeta"]);
        expect(new Set(body.entries.map((e) => e.kind))).toEqual(new Set(["dir"]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a read that never answers is a bounded 200 blocked: 'timeout', not a hung request", async () => {
      // Drive the deadline down so the test does not wait the real 10s, then
      // inject a readdir that never settles (the hung-mount shape).
      const saved = process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
      process.env.SUBSHELL_FS_READ_TIMEOUT_MS = "30";
      try {
        setFilesReaddirForTests(() => new Promise<string[]>(() => {}));
        const started = Date.now();
        const res = await explore({ cookieToken: cookie, path: "/tmp" });
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(3_000); // bounded, not the 10s wait
        const body = (await res.json()) as {
          blocked?: string;
          entries: unknown[];
          parent: string | null;
        };
        expect(body.blocked).toBe("timeout");
        expect(body.entries).toEqual([]);
        // The escape routes the panel needs to recover still ride the response:
        // the parent (toward a readable folder) and the saved-shortcut sections.
        expect(body.parent).toBe("/");
      } finally {
        if (saved === undefined) delete process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
        else process.env.SUBSHELL_FS_READ_TIMEOUT_MS = saved;
      }
    });

    it("a hung gate realpath is a bounded 200 blocked: 'timeout', not a 500", async () => {
      // The confinement gate realpaths a candidate for a restricted caller. When
      // THAT read is the one that hangs (mac-builder's exact fault: a Linux-style
      // /home path under an auto_home mount), the route must classify it as the
      // same recoverable blocked listing the readdir path produces, not leak the
      // FsDeadlineError to the 500 handler. Forces the gate off its fast path via
      // a set FS_ROOT, then hangs the injected realpath.
      const saved = process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
      const savedRoot = process.env.SUBSHELL_FS_ROOT;
      process.env.SUBSHELL_FS_READ_TIMEOUT_MS = "30";
      process.env.SUBSHELL_FS_ROOT = savedRoot ?? "/"; // any set root keeps the gate off the fast path
      try {
        setFilesRealpathForTests(() => new Promise<string>(() => {}));
        const started = Date.now();
        const res = await explore({ cookieToken: cookie, path: "/tmp" });
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(3_000);
        const body = (await res.json()) as { blocked?: string; entries: unknown[] };
        expect(body.blocked).toBe("timeout");
        expect(body.entries).toEqual([]);
      } finally {
        if (saved === undefined) delete process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
        else process.env.SUBSHELL_FS_READ_TIMEOUT_MS = saved;
        if (savedRoot === undefined) delete process.env.SUBSHELL_FS_ROOT;
        else process.env.SUBSHELL_FS_ROOT = savedRoot;
      }
    });

    it("a restricted browse still answers with a clean status, never a 500", async () => {
      // The async gate now runs under a confinement root that cannot resolve.
      // Whatever the exact refusal, it must be a well-formed 200/403 — the move
      // to promises must not turn a confinement reject into an unhandled throw.
      const saved = process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
      const savedRoot = process.env.SUBSHELL_FS_ROOT;
      process.env.SUBSHELL_FS_READ_TIMEOUT_MS = "30";
      process.env.SUBSHELL_FS_ROOT = "/nonexistent-fs-root-that-cannot-resolve";
      try {
        setFilesReaddirForTests(() => new Promise<string[]>(() => {}));
        const res = await explore({ cookieToken: cookie, path: "/tmp" });
        // A confinement root that cannot be resolved refuses the path (403) or
        // times it out (200 blocked) — never a 500 either way.
        expect([200, 403]).toContain(res.status);
      } finally {
        if (saved === undefined) delete process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
        else process.env.SUBSHELL_FS_READ_TIMEOUT_MS = saved;
        if (savedRoot === undefined) delete process.env.SUBSHELL_FS_ROOT;
        else process.env.SUBSHELL_FS_ROOT = savedRoot;
      }
    });
  });

  // A real user's /tmp held 32,091 entries: one JSON body of 2.8 MB that
  // froze the picker. The route now pages; these pin the seam. The honest
  // split (the payload is bounded, the scan is not) is documented at the
  // pagination site in `files.route.ts`.
  describe("explore pagination", () => {
    afterEach(() => setFilesReaddirForTests(null));

    type Page = {
      path: string;
      parent: string | null;
      entries: { name: string }[];
      nextCursor?: string;
      truncated?: boolean;
      recent: { path: string }[];
      favorites: { path: string }[];
      blocked?: string;
    };

    /** Builds one /explore request. `limit` accepts a string so a test can
     *  send exactly the value the `t.Numeric` schema parse is meant to refuse. */
    function pagedRequest(opts: { path: string; cursor?: string; limit?: number | string }): Request {
      const url = new URL("http://localhost:3080/api/files/explore");
      url.searchParams.set("path", opts.path);
      if (opts.cursor !== undefined) url.searchParams.set("cursor", opts.cursor);
      if (opts.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
      return new Request(url.toString(), { headers: new Headers({ cookie: `better-auth.session_token=${cookie}` }) });
    }

    async function paged(opts: { path: string; cursor?: string; limit?: number | string }): Promise<Response> {
      return filesRoutes.fetch(pagedRequest(opts));
    }

    /** A temp dir with `count` REAL child dirs: the route stats every name
     *  `readdir` returns, so a faked listing alone would sort down to nothing. */
    function dirWithChildren(count: number): string {
      const dir = mkdtempSync(join(tmpdir(), "subshell-paging-"));
      for (let i = 1; i <= count; i++) mkdirSync(join(dir, `folder-${String(i).padStart(3, "0")}`));
      return dir;
    }

    it("limit=10 pages a 50-entry listing, and the cursor walk covers the sorted whole", async () => {
      const dir = dirWithChildren(50);
      try {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        for (;;) {
          const res = await paged({ path: dir, limit: 10, cursor });
          expect(res.status).toBe(200);
          const body = (await res.json()) as Page;
          expect(body.entries).toHaveLength(10);
          seen.push(...body.entries.map((e) => e.name));
          pages++;
          if (body.nextCursor === undefined) break;
          cursor = body.nextCursor;
          expect(pages).toBeLessThan(10); // a cursor loop that never ends fails, not hangs
        }
        expect(pages).toBe(5);
        // Disjoint AND complete: the walk equals one unpaginated read.
        expect(new Set(seen).size).toBe(50);
        const whole = (await (await paged({ path: dir, limit: 1000 })).json()) as Page;
        expect(seen).toEqual(whole.entries.map((e) => e.name));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("the default limit pages at 200, and supplied limits clamp to 1..1000", async () => {
      const dir = dirWithChildren(250);
      try {
        const body = (await (await paged({ path: dir })).json()) as Page;
        expect(body.entries).toHaveLength(200);
        expect(body.nextCursor).toBe("200");
        // `truncated` is the remote-only flag: a local page never carries it.
        expect(body.truncated).toBeUndefined();
        const rest = (await (await paged({ path: dir, cursor: "200" })).json()) as Page;
        expect(rest.entries).toHaveLength(50);
        expect(rest.nextCursor).toBeUndefined();
        const one = (await (await paged({ path: dir, limit: 0 })).json()) as Page;
        expect(one.entries).toHaveLength(1);
        expect(one.nextCursor).toBe("1");
        const huge = (await (await paged({ path: dir, limit: 99_999 })).json()) as Page;
        expect(huge.entries).toHaveLength(250);
        expect(huge.nextCursor).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a non-numeric limit answers 400 from the schema parse, symmetric with the cursor syntax gate", async () => {
      // `limit=abc` dies in the `t.Numeric` parse before the handler runs, so
      // the assertion rides the GLOBAL error handler mounted the way
      // createApp() does (the uploads-route precedent): the bare `filesRoutes`
      // instance answers Elysia's raw 422 with a string body, while the
      // production contract is the structured 400 INPUT_VALIDATION_ERROR.
      const app = new Elysia().use(errorHandlerPlugin).use(filesRoutes);
      const res = await app.fetch(pagedRequest({ path: "/tmp", limit: "abc" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
    });

    it("a 1,001-entry listing proves the upper clamp: 99,999 answers exactly 1,000 and the next cursor", async () => {
      // The 250-entry dir above can't see the ceiling: only a listing that
      // actually overruns 1,000 fails if the clamp itself is deleted. The
      // route stats every name, so the children have to be real.
      const dir = dirWithChildren(1001);
      try {
        const res = await paged({ path: dir, limit: 99_999 });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Page;
        expect(body.entries).toHaveLength(1000);
        expect(body.nextCursor).toBe("1000");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a cursor past the end self-heals: empty page, no cursor, 200 (the directory shrank since the last mint)", async () => {
      const dir = dirWithChildren(5);
      try {
        const res = await paged({ path: dir, cursor: "999999999999" });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Page;
        expect(body.entries).toEqual([]);
        expect(body.nextCursor).toBeUndefined();
        expect(body.path).toBe(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a malformed cursor is the route's 400 (a syntax gate: valid-but-never-minted cursors are fine)", async () => {
      const dir = dirWithChildren(3);
      try {
        for (const cursor of ["abc", "-1", "1.5", " 1"]) {
          expect((await paged({ path: dir, cursor })).status).toBe(400);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a cursor over the 20-char bound answers 400 from the schema parse, and exactly 20 stays a legal huge cursor", async () => {
      // The loop above only exercises sub-20-char cursors, so nothing there
      // sees the `maxLength: 20` guard: a 21-digit cursor passes the handler's
      // all-digit syntax gate, so only the schema refuses it. A schema refusal
      // must read the structured 400 the production contract promises, so the
      // app is mounted the way createApp() does (the non-numeric-limit
      // precedent), not the bare `filesRoutes` that answers Elysia's raw 422.
      const app = new Elysia().use(errorHandlerPlugin).use(filesRoutes);
      const over = await app.fetch(pagedRequest({ path: "/tmp", cursor: "9".repeat(21) }));
      expect(over.status).toBe(400);
      expect(((await over.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
      // Exactly 20 passes both gates: still a legitimate past-the-end request,
      // so it self-heals to an empty page like the shorter huge cursor above.
      const dir = dirWithChildren(3);
      try {
        const res = await paged({ path: dir, cursor: "9".repeat(20) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Page;
        expect(body.entries).toEqual([]);
        expect(body.nextCursor).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("the malformed-cursor 400 is paid before the scan, so the directory is never read", async () => {
      // The shape check sits ABOVE the walk in the handler so a bogus cursor on
      // a 32k-entry folder costs nothing. The statuses loop above cannot see a
      // regression that moves the check below the scan, because the 400 looks
      // identical either way; the empty recorder here can.
      const seen: string[] = [];
      setFilesReaddirForTests((path) => {
        seen.push(path);
        return Promise.resolve([]);
      });
      const res = await paged({ path: "/tmp", cursor: "abc" });
      expect(res.status).toBe(400);
      expect(seen).toEqual([]);
    });

    it("pages carry parent, recent and favorites intact", async () => {
      const dir = dirWithChildren(7);
      const favorites = new FavoritesRepository(db);
      await new RecentPathsRepository(db).touch(userId, "/tmp/paging-recent", null);
      await favorites.setFavorite(userId, "directory", "/tmp/paging-star", true);
      try {
        const body = (await (await paged({ path: dir, limit: 2, cursor: "4" })).json()) as Page;
        // The page is the slice of the SORTED whole, not of readdir order.
        expect(body.entries.map((e) => e.name)).toEqual(["folder-005", "folder-006"]);
        expect(body.nextCursor).toBe("6");
        expect(body.parent).not.toBeNull();
        expect(body.recent.map((r) => r.path)).toContain("/tmp/paging-recent");
        expect(body.favorites.map((f) => f.path)).toContain("/tmp/paging-star");
      } finally {
        await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
        await favorites.setFavorite(userId, "directory", "/tmp/paging-star", false);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a blocked listing keeps its shape under pagination: empty entries, no cursor, path intact", async () => {
      setFilesReaddirForTests(() => {
        const err = new Error("EPERM: permission denied") as NodeJS.ErrnoException;
        err.code = "EPERM";
        return Promise.reject(err);
      });
      try {
        const res = await paged({ path: "/tmp", limit: 5, cursor: "0" });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Page;
        expect(body.blocked).toBe("permission");
        expect(body.entries).toEqual([]);
        expect(body.nextCursor).toBeUndefined();
        expect(body.path).toBe("/tmp");
      } finally {
        setFilesReaddirForTests(null);
      }
    });
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

    it("reports the control-plane host's home directory", async () => {
      const res = await recent({ cookieToken: cookie });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { home: string | null };
      expect(body.home).toBe(homedir());
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

      it("an agent node that has not reported answers null — the plane cannot see its disk", async () => {
        // The offline `ownNodeId` above never connected, so the registry has
        // no `ready` facts for it. Null, not homedir(): the PLANE's home would
        // be a wrong absolute path on the launch target.
        const onX = (await (await recentScoped(ownNodeId)).json()) as { home: string | null };
        expect(onX.home).toBeNull();
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
