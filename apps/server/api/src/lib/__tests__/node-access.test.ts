import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { NodeSharePermission } from "@/db/types/node-shares.db-types.js";
import {
  loadNodeAccess,
  nodeCanConfigure,
  nodeCanLaunch,
  nodeCanManage,
  nodeCanManageFor,
  resolveNodeAccess,
} from "@/lib/node-access.js";

/**
 * The node-access resolver (spec 2026-08-31 §2) — one authorization question,
 * deliberately NOT the subshell rule: on nodes ANY share level grants launch,
 * `edit`/`owner` grants config, and only the owner manages (delete/shares;
 * routes add the seeded-`local` admin exception themselves).
 */

// Salted unique ids (same pattern as nodes.repository.test.ts): every test file
// in one `bun test` invocation shares the temp DB and seq restarts per file.
const salt = Math.random().toString(36).slice(2, 8);
let seq = 0;
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

const grant = (granteeUserId: string | null, permission: NodeSharePermission) => ({ granteeUserId, permission });
const node = (id: string, ownerUserId: string) => ({ id, ownerUserId });

describe("resolveNodeAccess (pure)", () => {
  it("the owner always resolves to owner — even as admin, even with no shares", () => {
    expect(resolveNodeAccess("alice", false, node("n1", "alice"), [])).toBe("owner");
    // Owner wins over the admin boost: an admin viewing their OWN node is owner,
    // not edit — otherwise nodeCanManage would wrongly deny them their own node.
    expect(resolveNodeAccess("alice", true, node("n1", "alice"), [])).toBe("owner");
    expect(resolveNodeAccess("alice", true, node("n1", "alice"), [grant(null, "view")])).toBe("owner");
  });

  it("an admin on a foreign node gets edit (spec §1 instance-wide edit)", () => {
    expect(resolveNodeAccess("root", true, node("n1", "alice"), [])).toBe("edit");
    // …and the boost never outranks a real owner-match above; a named grant on
    // the admin is irrelevant — admin already resolves to edit.
    expect(resolveNodeAccess("root", true, node("n1", "alice"), [grant("root", "view")])).toBe("edit");
  });

  it("Everyone(view) alone → view", () => {
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [grant(null, "view")])).toBe("view");
  });

  it("Everyone(edit) → edit; a named/edit grant → edit", () => {
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [grant(null, "edit")])).toBe("edit");
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [grant("bob", "edit")])).toBe("edit");
  });

  it("the highest of Everyone + named grants wins (view+edit mix → edit)", () => {
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [grant(null, "view"), grant("bob", "edit")])).toBe(
      "edit",
    );
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [grant(null, "edit"), grant("bob", "view")])).toBe(
      "edit",
    );
  });

  it("a grant naming someone else does not leak to the viewer", () => {
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [grant("carol", "edit")])).toBe("none");
  });

  it("no grant, not owner, not admin → none", () => {
    expect(resolveNodeAccess("bob", false, node("n1", "alice"), [])).toBe("none");
  });
});

describe("capability predicates (spec §2 — NOT the subshell rule)", () => {
  it("ANY level except none grants launch — view included", () => {
    expect(nodeCanLaunch("view")).toBe(true); // the §2 delta vs subshells: pinned
    expect(nodeCanLaunch("edit")).toBe(true);
    expect(nodeCanLaunch("owner")).toBe(true);
    expect(nodeCanLaunch("none")).toBe(false);
  });

  it("config needs edit or owner", () => {
    expect(nodeCanConfigure("view")).toBe(false);
    expect(nodeCanConfigure("edit")).toBe(true);
    expect(nodeCanConfigure("owner")).toBe(true);
    expect(nodeCanConfigure("none")).toBe(false);
  });

  it("manage (delete/re-share) is owner-only — admins included get false here", () => {
    expect(nodeCanManage("owner")).toBe(true);
    expect(nodeCanManage("edit")).toBe(false);
    expect(nodeCanManage("view")).toBe(false);
    expect(nodeCanManage("none")).toBe(false);
  });

  it("a view grant launches but does not configure", () => {
    const access = resolveNodeAccess("bob", false, node("n1", "alice"), [grant(null, "view")]);
    expect(nodeCanLaunch(access)).toBe(true);
    expect(nodeCanConfigure(access)).toBe(false);
    expect(nodeCanManage(access)).toBe(false);
  });
});

describe("nodeCanManageFor (ONE rule shared by the gate and the views)", () => {
  it("owner always manages, on either kind", () => {
    expect(nodeCanManageFor("agent", "owner", false)).toBe(true);
    expect(nodeCanManageFor("local", "owner", false)).toBe(true);
    expect(nodeCanManageFor("local", "owner", true)).toBe(true);
  });

  it("edit/view manage only via the seeded-`local` admin exception", () => {
    // Admin on `local` manages (T3 ruling); admin on an agent node does not.
    expect(nodeCanManageFor("local", "edit", true)).toBe(true);
    expect(nodeCanManageFor("agent", "edit", true)).toBe(false);
    expect(nodeCanManageFor("local", "view", true)).toBe(true); // local is Everyone/edit → admin resolves edit anyway
    // A plain grantee never manages, whatever the kind.
    expect(nodeCanManageFor("local", "edit", false)).toBe(false);
    expect(nodeCanManageFor("agent", "edit", false)).toBe(false);
    expect(nodeCanManageFor("agent", "view", false)).toBe(false);
    expect(nodeCanManageFor("agent", "none", true)).toBe(false);
  });
});

describe("loadNodeAccess", () => {
  const deps = {
    nodes: new NodesRepository(db),
    shares: new NodeSharesRepository(db),
    userMeta: new UserMetaRepository(db),
  };

  beforeAll(async () => {
    await runMigrations();
  });

  async function mkNode(ownerUserId: string) {
    return deps.nodes.create({
      id: unique("n"),
      ownerUserId,
      name: unique("node"),
      kind: "agent",
      status: "offline",
    });
  }

  async function mkAdmin(): Promise<string> {
    const userId = unique("u");
    await (db as any).insertInto("userMeta").values({ userId, role: "admin" }).execute();
    return userId;
  }

  it("a missing row yields { undefined, 'none' } so routes can 404 uniformly", async () => {
    const { row, access } = await loadNodeAccess(deps, unique("u"), unique("ghost"));
    expect(row).toBeUndefined();
    expect(access).toBe("none");
  });

  it("resolves owner / admin-edit / grantee-view / none from real rows + roles", async () => {
    const owner = unique("u");
    const admin = await mkAdmin();
    const stranger = unique("u");
    const grantee = unique("u");
    const n = await mkNode(owner);

    expect((await loadNodeAccess(deps, owner, n.id)).access).toBe("owner");
    expect((await loadNodeAccess(deps, admin, n.id)).access).toBe("edit");
    // Invisible to a stranger — same "none" as a missing row (404, never 403).
    expect((await loadNodeAccess(deps, stranger, n.id)).access).toBe("none");

    await deps.shares.replaceForNode(n.id, [grant(grantee, "view")], owner);
    expect((await loadNodeAccess(deps, grantee, n.id)).access).toBe("view");
    // row comes back for the resolved viewer
    const loaded = await loadNodeAccess(deps, owner, n.id);
    expect(loaded.row?.id).toBe(n.id);
  });

  it("Everyone grant reaches every viewer", async () => {
    const owner = unique("u");
    const viewer = unique("u");
    const n = await mkNode(owner);
    await deps.shares.replaceForNode(n.id, [grant(null, "edit")], owner);
    expect((await loadNodeAccess(deps, viewer, n.id)).access).toBe("edit");
  });

  it("allowAdminAndShares:false (machine actor) — admin loses the boost, grants ignored", async () => {
    const owner = unique("u");
    const admin = await mkAdmin();
    const grantee = unique("u");
    const n = await mkNode(owner);
    await deps.shares.replaceForNode(n.id, [grant(grantee, "edit"), grant(null, "view")], owner);

    const opts = { allowAdminAndShares: false } as const;
    // Admin who is not the owner drops to none…
    expect((await loadNodeAccess(deps, admin, n.id, opts)).access).toBe("none");
    // …as does a grantee — no share rows are consulted at all…
    expect((await loadNodeAccess(deps, grantee, n.id, opts)).access).toBe("none");
    // …while the owner-match still resolves (a machine key acts on its own owner's rows).
    expect((await loadNodeAccess(deps, owner, n.id, opts)).access).toBe("owner");
  });
});
