import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";

let seq = 0;
// Salt per file: every test file in one `bun test` invocation shares one process
// (same pid) and its seq restarts at 0, so the bare pid+seq id would collide
// across files (e.g. the nodes owner+name unique index).
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

async function mkNode(repo: NodesRepository, ownerUserId: string, name = unique("node")) {
  return repo.create({
    id: unique("n"),
    ownerUserId,
    name,
    kind: "agent",
    status: "offline",
    createdAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  await runMigrations();
});

describe("NodeSharesRepository", () => {
  const nodes = new NodesRepository(db);
  const shares = new NodeSharesRepository(db);

  it("replace stores Everyone + named grants; shrinking replace leaves nothing stale", async () => {
    const n = await mkNode(nodes, unique("u"));
    const u1 = unique("u");
    await shares.replaceForNode(
      n.id,
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: u1, permission: "edit" },
      ],
      n.ownerUserId,
    );
    expect(await shares.listForNode(n.id)).toHaveLength(2);
    await shares.replaceForNode(n.id, [{ granteeUserId: u1, permission: "view" }], n.ownerUserId);
    const after = await shares.listForNode(n.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.permission).toBe("view");
  });

  it("duplicate grantees (Everyone included) collapse to the last entry", async () => {
    const n = await mkNode(nodes, unique("u"));
    await shares.replaceForNode(
      n.id,
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: null, permission: "edit" },
      ],
      n.ownerUserId,
    );
    const rows = await shares.listForNode(n.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permission).toBe("edit");
  });

  it("listForNodes buckets per node, empty arrays included", async () => {
    const a = await mkNode(nodes, unique("u"));
    const b = await mkNode(nodes, unique("u"));
    await shares.replaceForNode(a.id, [{ granteeUserId: unique("u"), permission: "view" }], a.ownerUserId);
    const map = await shares.listForNodes([a.id, b.id]);
    expect(map.get(a.id)).toHaveLength(1);
    expect(map.get(b.id)).toHaveLength(0);
  });
});
