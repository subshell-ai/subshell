import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { filesRoutes } from "@/api/files.route.js";
import { db } from "@/db/index.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The LOCAL folder picker under a `local` allowlist.
 *
 * Both cases here were shipped broken and caught in review, which is why they
 * are pinned rather than left to the happy path:
 *
 * 1. The landing directory was dead code (`raw || fallback` where `raw` had
 *    already defaulted to home), so a restricted caller's first open — which
 *    sends no path at all — 403'd with no way back except typing a path.
 * 2. Listings were filtered with a DESCENDANT test, which hides the ancestors
 *    of a rule. Browsing `/` with a rule of `<root>/work` showed nothing, so
 *    there was no way down to the one directory that was permitted.
 *
 * Neither was a security hole — the launch gate is separate and strict — but
 * together they made the feature unusable for the people it constrains.
 */
describe("local folder picker under an allowlist", () => {
  const email = `fscope-${crypto.randomUUID()}@subshell.local`;
  const password = "fscope-pass-1234";
  let cookie: string;
  let root: string;
  let allowed: string;

  const repo = new NodeAllowedDirsRepository(db);

  beforeAll(async () => {
    await setupAuthTables();
    // The `local` node row is seeded at boot, not by route tests — and
    // `node_allowed_dirs` has an FK onto it, so the rules cannot be written
    // without it.
    await ensureLocalNode(db);
    // A plain user: NOT an admin, so they cannot manage `local` and therefore
    // get the scoped view. (An admin manages `local` and browses unfiltered —
    // they are the one defining the rules.)
    await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    // realpath'd, because that is what the PUT route stores: rules are
    // resolved on their node at write time so a rule and a launch candidate
    // are the same string. On macOS the tmpdir is behind /private, so a raw
    // rule here would silently test the wrong thing.
    root = realpathSync(mkdtempSync(join(tmpdir(), "subshell-fscope-")));
    allowed = join(root, "work");
    mkdirSync(join(allowed, "project"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
  });

  afterAll(async () => {
    await repo.clearForNode(LOCAL_NODE_ID);
    rmSync(root, { recursive: true, force: true });
    await deleteUserByEmailOrId(email);
  });

  function explore(path?: string) {
    const qs = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
    return filesRoutes.fetch(
      new Request(`http://localhost:3080/api/files/explore${qs}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }

  it("opens on an allowed directory rather than 403ing, when no path is given", async () => {
    // The picker's first request carries no path. Home is almost never inside
    // the rules, so landing there would be a dead end.
    const res = await explore();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(allowed);
  });

  it("lists an ancestor of a rule, and shows the way down to it", async () => {
    const res = await explore(root);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { name: string; path: string }[] };
    const names = body.entries.map((e) => e.name);
    // The stepping stone is present...
    expect(names).toContain("work");
    // ...and the sibling that could never be launched in is not.
    expect(names).not.toContain("secrets");
  });

  it("lists inside the rule normally", async () => {
    const res = await explore(allowed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { name: string }[] };
    expect(body.entries.map((e) => e.name)).toContain("project");
  });

  it("refuses a directory that is neither inside a rule nor on the way to one", async () => {
    expect((await explore(join(root, "secrets"))).status).toBe(403);
  });

  it("an unrestricted node is unaffected — the whole point of empty-means-open", async () => {
    await repo.clearForNode(LOCAL_NODE_ID);
    try {
      const res = await explore(join(root, "secrets"));
      expect(res.status).toBe(200);
    } finally {
      await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
    }
  });
});
