import { hostname } from "node:os";
import type { Kysely } from "kysely";
import { ensureSystemUser } from "@/auth/system-user.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";

/**
 * Seeds (or repairs) the `local` node row + its Everyone/edit share — the
 * control-plane host as a first-class node (spec 2026-08-31 §2). Boot-time,
 * idempotent: a missing row or missing Everyone share is created; an admin's
 * deliberate deletions are re-created ONLY here at boot (deleting the row
 * disables local launch until restart — accepted v1 behavior, spec §2).
 *
 * Create-if-absent only: an existing row is never overwritten (a rename
 * survives), and the share repair merges — existing named grants ride through
 * the replace untouched, only the missing Everyone/edit row is added.
 *
 * @param db - The app's Kysely handle (same one `src/index.ts` boots with)
 */
export async function ensureLocalNode(db: Kysely<Database>): Promise<void> {
  const nodes = new NodesRepository(db);
  const shares = new NodeSharesRepository(db);
  const ownerUserId = await ensureSystemUser();

  if (!(await nodes.findById(LOCAL_NODE_ID))) {
    await nodes.create({
      id: LOCAL_NODE_ID,
      ownerUserId,
      name: "Local",
      kind: "local",
      os: process.platform === "darwin" ? "darwin" : "linux",
      arch: process.arch,
      // No Bun.hostname exists (the `hostname` in bun-types is on
      // TCPSocketListener); node:os is what session-manager already uses.
      // Drop the mDNS `.local` suffix — it clashes with the node's id spelling
      // in UIs and is noise in the picker.
      hostname: hostname().replace(/\.local$/, "") || "localhost",
      // The control-plane host is definitionally online (it never connects).
      status: "online",
    });
  }

  const existing = await shares.listForNode(LOCAL_NODE_ID);
  if (!existing.some((s) => s.granteeUserId === null)) {
    // Replace-merge: replay the current entries so named grants survive the
    // transactional delete-then-insert, and add only the missing Everyone/edit.
    // NOTE: replaying through replaceForNode re-stamps every replayed row's
    // createdBy/createdAt — consumers must not treat those columns as immutable.
    await shares.replaceForNode(
      LOCAL_NODE_ID,
      [
        ...existing.map((s) => ({ granteeUserId: s.granteeUserId, permission: s.permission })),
        { granteeUserId: null, permission: "edit" as const },
      ],
      ownerUserId,
    );
  }
}
