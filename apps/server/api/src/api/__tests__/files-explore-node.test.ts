import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { filesRoutes } from "@/api/files.route.js";
import { db } from "@/db/index.js";
import { FavoritesRepository } from "@/db/repositories/favorites.repository.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `GET /api/files/explore?node=<id>` — the REMOTE half of the folder picker.
 * The scripted node rides the real `sendCommand` chain (signing, seq, jti
 * correlation) and gates the frame through the real `parseNodeCommandBody`,
 * so these tests pin the whole server-side path: visibility (404 never 403),
 * the protocol-v3 feature gate, `~`/empty → agent-home, the local-shape
 * pass-through, and the error mapping. The agent's own fs-ls semantics live
 * in `apps/node/agent/src/__tests__/commands-fs-ls.test.ts`.
 *
 * The local browse (omitted / 'local') is pinned by `files-route.test.ts`;
 * the first test here only proves the node param never diverts it.
 */

// errorHandlerPlugin mounted like createApp() — the remote browse answers
// the structured error contract through the GLOBAL handler (throwApiError),
// which the standalone `filesRoutes.fetch` in files-route.test.ts never needs
// because its FilesError carriers ride Elysia's native status mapping.
const app = new Elysia().use(errorHandlerPlugin).use(filesRoutes);

const password = "explore-node-pass-1";
const LISTING = {
  path: "/home/nodeuser/projects",
  parent: "/home/nodeuser",
  entries: [{ name: "subshell", path: "/home/nodeuser/projects/subshell", kind: "dir" as const }],
  truncated: false,
};

describe("files explore ?node (remote folder picker)", () => {
  let userId: string;
  let cookie: string;
  const email = `explore-node-${crypto.randomUUID()}@subshell.local`;
  const createdSubshellIds: string[] = [];
  const createdNodeIds: string[] = [];
  const tempDirs: string[] = [];
  let nodes: NodesRepository;

  /** The browse agent's node — attach a scripted connection when a command must answer. */
  let nodeV3: string;
  /** A row that exists but the viewer cannot see. */
  let nodeInvisible: string;

  beforeAll(async () => {
    await setupAuthTables();
    nodes = new NodesRepository(db);
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    nodeV3 = crypto.randomUUID();
    createdNodeIds.push(nodeV3);
    await nodes.create({
      id: nodeV3,
      ownerUserId: userId,
      name: `browse-${nodeV3}`,
      kind: "agent",
      status: "offline",
    });
    nodeInvisible = crypto.randomUUID();
    createdNodeIds.push(nodeInvisible);
    await nodes.create({
      id: nodeInvisible,
      ownerUserId: `ghost-${crypto.randomUUID()}`,
      name: `ghost-${nodeInvisible}`,
      kind: "agent",
      status: "offline",
    });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const sid of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", sid).execute();
    for (const id of createdNodeIds) await nodes.deleteById(id);
    await deleteUserByEmailOrId(email);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "subshell-explore-node-"));
    tempDirs.push(dir);
    return dir;
  }

  function explore(opts: { node?: string; path?: string; bearer?: string }) {
    const url = new URL("http://localhost:3080/api/files/explore");
    if (opts.node !== undefined) url.searchParams.set("node", opts.node);
    if (opts.path !== undefined) url.searchParams.set("path", opts.path);
    const headers = new Headers();
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    else headers.set("cookie", `better-auth.session_token=${cookie}`);
    return app.fetch(new Request(url.toString(), { headers }));
  }

  /** Attaches a scripted agent answering fs_ls with `listing` (an Error = refusal). */
  function agent(listing?: unknown): ScriptedNode {
    return attachScriptedNode(nodeV3, { fs_ls: () => (listing === undefined ? LISTING : listing) });
  }

  it("omitted node and node=local browse the control plane — the agent never sees a frame", async () => {
    const local = tempDir();
    const scripted = agent();
    try {
      for (const node of [undefined, "local"]) {
        const res = await explore({ node, path: local });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          path: string;
          entries: unknown[];
          recent: unknown[];
          favorites: unknown[];
        };
        expect(body.path).toBe(local);
        expect(Array.isArray(body.entries)).toBe(true);
      }
      expect(scripted.countOf("fs_ls")).toBe(0);
    } finally {
      scripted.detach();
    }
  });

  it("remote browse passes the agent listing through in the local response shape", async () => {
    const scripted = agent();
    try {
      const res = await explore({ node: nodeV3, path: "/home/nodeuser/projects" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof LISTING & {
        recent: unknown[];
        favorites: unknown[];
        truncated?: boolean;
      };
      expect(body.path).toBe(LISTING.path);
      expect(body.parent).toBe(LISTING.parent);
      expect(body.entries).toEqual(LISTING.entries);
      // The shortcut sections are answered PER NODE (0034) — this fixture's
      // node has no rows yet, and rows saved for `local` or another user
      // never ride in here. The positive node-scoped sections are the next
      // test's job; these two assertions pin the negatives.
      expect(body.recent).toEqual([]);
      expect(body.favorites).toEqual([]);
      // The `truncated` flag is wire-side future-proofing, not part of the
      // explore response — the serializer must not leak it to the browser.
      expect(body.truncated).toBeUndefined();

      const cmds = scripted.cmdsOf("fs_ls");
      expect(cmds).toHaveLength(1);
      expect(cmds[0]?.path).toBe("/home/nodeuser/projects");
    } finally {
      scripted.detach();
    }
  });

  it("recent + roots + home on a constrained node all answer to its rules", async () => {
    // The launch rules are the picker's scope on the NODE transport too:
    // recents filter to them, a home beyond them seeds nothing (the form
    // would otherwise pre-fill a directory this caller gets a 403 on), and
    // a browse that lands outside them falls back to showing the rules
    // themselves — the same landing discipline the local route pins.
    const memberEmail = `scope-member-${crypto.randomUUID()}@subshell.local`;
    const members = new NodeSharesRepository(db);
    const dirs = new NodeAllowedDirsRepository(db);
    const recents = new RecentPathsRepository(db);
    const memberUserId = await new UsersRepository(db).createUser({
      email: memberEmail,
      name: memberEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    const memberCookie = await signIn(memberEmail, password);
    await members.replaceForNode(nodeV3, [{ granteeUserId: memberUserId, permission: "view" }], userId);
    await dirs.replaceForNode(nodeV3, ["/home/scripted/projects"]);
    // The scripted agent reports homeDir /home/scripted — OUTSIDE that rule.
    const scripted = agent();
    await recents.touch(memberUserId, "/home/scripted/projects/app", "inside", nodeV3);
    await recents.touch(memberUserId, "/home/scripted/outside", "gone", nodeV3);
    try {
      const getAs = (path: string, who: string) =>
        app.fetch(
          new Request(`http://localhost:3080${path}`, {
            headers: new Headers({ cookie: `better-auth.session_token=${who}` }),
          }),
        );
      const recent = (await (await getAs(`/api/files/recent?node=${nodeV3}`, memberCookie)).json()) as {
        paths: { path: string }[];
        home: string | null;
      };
      expect(recent.paths.map((r) => r.path)).toEqual(["/home/scripted/projects/app"]);
      expect(recent.home).toBeNull();
      // The manager's answer is unfiltered: their home, their scope.
      const own = (await (await getAs(`/api/files/recent?node=${nodeV3}`, cookie)).json()) as {
        home: string | null;
      };
      expect(own.home).toBe("/home/scripted");

      // Browsing "~" (agent home, outside the rules) returns the RULES as
      // the entries — no empty panel, no missing way back. (The LISTING the
      // scripted agent answers sits entirely outside the rule; the owner's
      // browse of the same path shows it unfiltered, one line below.)
      const memberBrowse = (await (await getAs(`/api/files/explore?node=${nodeV3}&path=~`, memberCookie)).json()) as {
        entries: { name: string; path: string; kind: string }[];
        parent: string | null;
      };
      const ownerBrowse = (await (await getAs(`/api/files/explore?node=${nodeV3}&path=~`, cookie)).json()) as {
        entries: { path: string }[];
      };
      expect(ownerBrowse.entries.length).toBeGreaterThan(0);
      expect(memberBrowse.entries).toEqual([
        { name: "/home/scripted/projects", path: "/home/scripted/projects", kind: "dir" },
      ]);
      expect(memberBrowse.parent).toBeNull();
    } finally {
      await db.deleteFrom("recentPaths").where("userId", "=", memberUserId).execute();
      await dirs.clearForNode(nodeV3);
      await members.replaceForNode(nodeV3, [], userId);
      await deleteUserByEmailOrId(memberEmail);
      scripted.detach();
    }
  });

  it("a remote browse hides a favorite that predates a tightened rule", async () => {
    // Rules tighten after stars are saved — the read-side filter is what
    // keeps such rows from being offered as shortcuts whose only outcome
    // is a refusal. (The write gate stops NEW ones; this covers the old.)
    const memberEmail = `scope-fav-${crypto.randomUUID()}@subshell.local`;
    const members = new NodeSharesRepository(db);
    const dirs = new NodeAllowedDirsRepository(db);
    const favorites = new FavoritesRepository(db);
    const memberUserId = await new UsersRepository(db).createUser({
      email: memberEmail,
      name: memberEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    const memberCookie = await signIn(memberEmail, password);
    await members.replaceForNode(nodeV3, [{ granteeUserId: memberUserId, permission: "view" }], userId);
    await favorites.setFavorite(memberUserId, "directory", "/home/nodeuser/projects", true, nodeV3);
    await dirs.replaceForNode(nodeV3, ["/home/nodeuser/projects/subshell"]); // tighter than the star
    const scripted = agent();
    try {
      const body = (await (
        await app.fetch(
          new Request(`http://localhost:3080/api/files/explore?node=${nodeV3}&path=/home/nodeuser/projects/subshell`, {
            headers: new Headers({ cookie: `better-auth.session_token=${memberCookie}` }),
          }),
        )
      ).json()) as { favorites: { path: string }[] };
      expect(body.favorites).toEqual([]);
      // Loosen the rule and the same row renders again — filtered, not gone.
      await dirs.replaceForNode(nodeV3, ["/home/nodeuser/projects"]);
      const after = (await (
        await app.fetch(
          new Request(`http://localhost:3080/api/files/explore?node=${nodeV3}&path=/home/nodeuser/projects`, {
            headers: new Headers({ cookie: `better-auth.session_token=${memberCookie}` }),
          }),
        )
      ).json()) as { favorites: { path: string }[] };
      expect(after.favorites.map((f) => f.path)).toEqual(["/home/nodeuser/projects"]);
    } finally {
      await favorites.setFavorite(memberUserId, "directory", "/home/nodeuser/projects", false, nodeV3);
      await dirs.clearForNode(nodeV3);
      await members.replaceForNode(nodeV3, [], userId);
      await deleteUserByEmailOrId(memberEmail);
      scripted.detach();
    }
  });

  it("remote browse ships the NODE's own Recent/Favorites; local rows never ride along", async () => {
    const scripted = agent();
    const recents = new RecentPathsRepository(db);
    const favorites = new FavoritesRepository(db);
    const nodeStar = "/home/nodeuser/starred";
    const nodeRecent = "/home/nodeuser/projects";
    const dupPath = "/home/nodeuser/dup";
    const localStar = "/local/starred-own";
    try {
      await recents.touch(userId, nodeRecent, "api", nodeV3);
      await recents.touch(userId, dupPath, "dup", nodeV3);
      await recents.touch(userId, localStar, null, "local");
      await favorites.setFavorite(userId, "directory", dupPath, true, nodeV3);
      await favorites.setFavorite(userId, "directory", nodeStar, true, nodeV3);
      await favorites.setFavorite(userId, "directory", localStar, true);

      const body = (await (await explore({ node: nodeV3, path: "/home/nodeuser/projects" })).json()) as {
        recent: { path: string; label: string | null }[];
        favorites: { path: string; label: string | null }[];
      };
      // Node X's rows appear walking node X — the dead-click rule the old
      // design hid behind was really a MISSING-node-column bug (0034).
      expect(new Set(body.favorites.map((f) => f.path))).toEqual(new Set([nodeStar, dupPath]));
      // …and a path is listed once: favorites win over recents, the local rule.
      expect(body.recent).toEqual([{ path: nodeRecent, label: "api" }]);
      expect(JSON.stringify(body)).not.toContain(localStar);

      // The other direction: `local`'s browse shows its own star and none of
      // the node's rows — the same path string means different machines.
      const lbody = (await (await explore({ path: tempDir() })).json()) as typeof body;
      expect(lbody.favorites.map((f) => f.path)).toContain(localStar);
      expect(JSON.stringify(lbody)).not.toContain(nodeRecent);
      expect(JSON.stringify(lbody)).not.toContain(nodeStar);
    } finally {
      await favorites.setFavorite(userId, "directory", nodeStar, false, nodeV3);
      await favorites.setFavorite(userId, "directory", dupPath, false, nodeV3);
      await favorites.setFavorite(userId, "directory", localStar, false);
      await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
      scripted.detach();
    }
  });

  it("PATCH /favorite on a node obeys that node's allowlist for non-managers", async () => {
    // A `view` grantee may browse and launch on the node but does not manage
    // it, so a favorite they plant must live inside the node's rules — the
    // same read/write symmetry `launchScopeFor` gives the listings: a row
    // the picker would filter straight back out reads as a star that
    // silently failed. The OWNER (manager) is exempt: they define the rules.
    const memberEmail = `fav-member-${crypto.randomUUID()}@subshell.local`;
    const members = new NodeSharesRepository(db);
    const dirs = new NodeAllowedDirsRepository(db);
    const memberUserId = await new UsersRepository(db).createUser({
      email: memberEmail,
      name: memberEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    const memberCookie = await signIn(memberEmail, password);
    await members.replaceForNode(nodeV3, [{ granteeUserId: memberUserId, permission: "view" }], userId);
    await dirs.replaceForNode(nodeV3, ["/home/nodeuser/projects"]);
    function patchAs(body: Record<string, unknown>, who: string) {
      return app.fetch(
        new Request("http://localhost:3080/api/files/favorite", {
          method: "PATCH",
          headers: new Headers({ cookie: `better-auth.session_token=${who}`, "content-type": "application/json" }),
          body: JSON.stringify(body),
        }),
      );
    }
    try {
      expect(
        (await patchAs({ path: "/home/nodeuser/secrets", favorite: true, node: nodeV3 }, memberCookie)).status,
      ).toBe(403);
      expect(
        (await patchAs({ path: "/home/nodeuser/projects/app", favorite: true, node: nodeV3 }, memberCookie)).status,
      ).toBe(200);
      expect((await patchAs({ path: "/outside-the-rules-too", favorite: true, node: nodeV3 }, cookie)).status).toBe(
        200,
      );
    } finally {
      await db.deleteFrom("favorites").where("nodeId", "=", nodeV3).execute();
      await dirs.clearForNode(nodeV3);
      await members.replaceForNode(nodeV3, [], userId);
      await deleteUserByEmailOrId(memberEmail);
    }
  });

  it("PATCH /favorite stars per node: an invisible node 404s, a relative path 400s, unstars hit one machine", async () => {
    const favorites = new FavoritesRepository(db);
    const nodePath = "/home/nodeuser/star-me";
    function patch(body: Record<string, unknown>) {
      return app.fetch(
        new Request("http://localhost:3080/api/files/favorite", {
          method: "PATCH",
          headers: new Headers({
            cookie: `better-auth.session_token=${cookie}`,
            "content-type": "application/json",
          }),
          body: JSON.stringify(body),
        }),
      );
    }
    try {
      // Star the SAME path on both machines — two rows, two meanings.
      expect((await patch({ path: nodePath, favorite: true, node: nodeV3 })).status).toBe(200);
      expect((await patch({ path: nodePath, favorite: true })).status).toBe(200);
      expect((await favorites.listByUser(userId, "directory", nodeV3)).map((f) => f.ref)).toContain(nodePath);
      expect((await favorites.listByUser(userId, "directory")).map((f) => f.ref)).toContain(nodePath);
      // Unstarring one machine leaves the other's row standing.
      expect((await patch({ path: nodePath, favorite: false, node: nodeV3 })).status).toBe(200);
      expect((await favorites.listByUser(userId, "directory", nodeV3)).map((f) => f.ref)).not.toContain(nodePath);
      expect((await favorites.listByUser(userId, "directory")).map((f) => f.ref)).toContain(nodePath);

      // A node the caller cannot see is 404 (the no-oracle rule /recent and
      // /explore apply) — and a node path is never resolved against THIS host.
      expect((await patch({ path: "/home/x", favorite: true, node: nodeInvisible })).status).toBe(404);
      expect((await patch({ path: "relative/x", favorite: true, node: nodeV3 })).status).toBe(400);
    } finally {
      await favorites.setFavorite(userId, "directory", nodePath, false);
    }
  });

  it("omitted path and '~' both reach the agent as '' (the AGENT's home is the honest default)", async () => {
    const scripted = agent({ ...LISTING, path: "/home/nodeuser", parent: "/home" });
    try {
      expect((await explore({ node: nodeV3 })).status).toBe(200);
      expect((await explore({ node: nodeV3, path: "~" })).status).toBe(200);
      expect(scripted.cmdsOf("fs_ls").map((c) => c.path)).toEqual(["", ""]);
    } finally {
      scripted.detach();
    }
  });

  it("a '~/' path is NOT expanded server-side (the remote HOME is unknown) — it rides to the agent verbatim", async () => {
    // The real agent answers `EINVAL:` for it; the scripted one echoes the
    // same refusal so the 400 mapping is pinned end-to-end.
    const scripted = agent(new Error("EINVAL: ~/repo"));
    try {
      const res = await explore({ node: nodeV3, path: "~/repo" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("BAD_REQUEST");
      expect(scripted.cmdsOf("fs_ls")[0]?.path).toBe("~/repo");
    } finally {
      scripted.detach();
    }
  });

  it("invisible node -> 404 (never 403 — the picker is no node-id oracle)", async () => {
    const scripted = agent(); // a live agent behind a ghost row would answer; it must never be asked
    try {
      const res = await explore({ node: nodeInvisible });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
      expect(scripted.countOf("fs_ls")).toBe(0);
    } finally {
      scripted.detach();
    }
  });

  it("unknown node id -> 404, same body shape as an invisible one", async () => {
    const res = await explore({ node: crypto.randomUUID() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
  });

  it("browse node with no live connection -> 409 NODE_OFFLINE", async () => {
    const res = await explore({ node: nodeV3, path: "/tmp" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_OFFLINE");
  });

  it("agent ENOENT answers the local 404 ('That path doesn't exist' on the picker)", async () => {
    const scripted = agent(new Error("ENOENT: /home/nodeuser/ghost"));
    try {
      const res = await explore({ node: nodeV3, path: "/home/nodeuser/ghost" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("NOT_FOUND_ERROR");
      expect(body.message).toBe("Path does not exist");
      // Agent refusal text is never echoed to the browser.
      expect(JSON.stringify(body)).not.toInclude("nodeuser/ghost");
    } finally {
      scripted.detach();
    }
  });

  it("agent EACCES answers the local 403 'Directory is not readable'", async () => {
    const scripted = agent(new Error("EACCES: /home/other"));
    try {
      const res = await explore({ node: nodeV3, path: "/home/other" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message: string }).message).toBe("Directory is not readable");
    } finally {
      scripted.detach();
    }
  });

  it("an ok:true payload that fails the contract is a 500, not a pass-through", async () => {
    const scripted = agent({ path: 42, parent: null, entries: [], truncated: false });
    try {
      const res = await explore({ node: nodeV3, path: "/x" });
      expect(res.status).toBe(500);
    } finally {
      scripted.detach();
    }
  });

  it("machine bearer -> 403 on the remote path too (browser affordance, either transport)", async () => {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "explore-node-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(id, userId);
    const res = await explore({ bearer: key, node: nodeV3 });
    expect(res.status).toBe(403);
  });
});
