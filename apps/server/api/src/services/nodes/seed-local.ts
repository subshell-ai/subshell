import { hostname } from "node:os";
import type { Kysely } from "kysely";
import { ensureSystemUser } from "@/auth/system-user.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";

/**
 * This host's short name, as both the `local` node row and the instance-name
 * default spell it.
 *
 * One helper so the two cannot disagree: the mDNS `.local` suffix is dropped
 * because it collides with the node's id spelling in UIs and is noise in the
 * picker, and an empty result falls back to `localhost`. No `Bun.hostname`
 * exists (the `hostname` in bun-types is on `TCPSocketListener`), so `node:os`
 * is what this and `subshell-manager` both use.
 */
export function localHostname(): string {
  return hostname().replace(/\.local$/, "") || "localhost";
}

/**
 * The control-plane host's own platform, in the vocabulary nodes speak
 * (`linux|darwin` × `process.arch`). The ONE mapping for "local's platform":
 * the seed writes it, the node view falls back to it (spec 2026-09-02 §4b),
 * so a future platform rule is edited in exactly one place.
 */
export function localPlatform(): { os: string; arch: string } {
  return { os: process.platform === "darwin" ? "darwin" : "linux", arch: process.arch };
}

/**
 * Seeds the `local` node row + its Everyone/edit share — the control-plane
 * host as a first-class node (spec 2026-08-31 §2). Boot-time, idempotent.
 *
 * **The switch semantics:** the presence of the Everyone/edit share row IS the
 * local-launch switch (spec §9 — no separate flag). It is seeded ONLY when the
 * `local` node row is itself created (first boot). On later boots an absent
 * Everyone row means an admin turned local launching OFF (the settings-card
 * toggle / `PUT /api/nodes/local/shares` deletes the row) — that is an
 * intentional disable and survives restarts: nothing here re-adds it. The
 * re-enable path is the toggle itself, which PUTs the row back; a restart must
 * never silently undo the admin's decision.
 *
 * The node row is create-if-absent only: an existing row is never overwritten
 * (a rename survives), and existing shares ride through untouched.
 *
 * @param db - The app's Kysely handle (same one `src/index.ts` boots with)
 */
export async function ensureLocalNode(db: Kysely<Database>): Promise<void> {
  const nodes = new NodesRepository(db);

  if (!(await nodes.findById(LOCAL_NODE_ID))) {
    const ownerUserId = await ensureSystemUser();
    await nodes.create({
      id: LOCAL_NODE_ID,
      ownerUserId,
      // "Server", not "Local": every user but the operator read the old label
      // as their own machine. An admin renames it from the node's page
      // (spec 2026-09-08); migration 0022 carries existing instances over.
      name: "Server",
      kind: "local",
      ...localPlatform(),
      hostname: localHostname(),
      // The control-plane host is definitionally online (it never connects).
      status: "online",
    });

    // First boot: seed the local-launch switch ON. This Everyone/edit row's
    // presence IS the switch (spec §9) — later boots must never re-add it,
    // because its absence is an admin's deliberate disable that outlives
    // restarts; the re-enable path is the settings-card toggle (a shares PUT).
    await new NodeSharesRepository(db).replaceForNode(
      LOCAL_NODE_ID,
      [{ granteeUserId: null, permission: "edit" }],
      ownerUserId,
    );
  }
}
