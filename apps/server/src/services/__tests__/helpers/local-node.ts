import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";

/**
 * Restores the shared `local` node to the exact state boot leaves it in.
 *
 * Every test file in one `bun test` invocation shares ONE database (see
 * apps/server/AGENTS.md), and `local` is a singleton row the whole app assumes
 * exists: seeded once at boot, owned by the system user, and carrying the
 * Everyone/`edit` share whose PRESENCE is the local-launch switch.
 *
 * A suite that mutates that row therefore has to put it back, and "put it
 * back" cannot mean "delete it" — a missing `local` is just as poisonous as a
 * renamed one. `nodes.repository.test.ts` left it owned by a fixture user with
 * its share revoked, and `seed-local.test.ts` left it deleted outright; between
 * them they broke 24 assertions across ten later files, all of which looked
 * like independent node/profile/harness bugs.
 *
 * The re-seed goes through the real {@link ensureLocalNode}, not a hand-written
 * copy of the row, so a restored `local` cannot drift from the one boot
 * creates. The delete first is required: `ensureLocalNode` is a no-op when any
 * row exists, so it would otherwise keep a fixture-owned or share-less one.
 */
export async function restoreLocalNode(): Promise<void> {
  await db.deleteFrom("nodeShares").where("nodeId", "=", LOCAL_NODE_ID).execute();
  await db.deleteFrom("nodes").where("id", "=", LOCAL_NODE_ID).execute();
  // The seed resolves the row's owner through `ensureSystemUser`, which reads
  // better-auth's `user` table — a table a suite testing only app repositories
  // has no reason to have migrated. Idempotent, so callers that already ran it
  // pay nothing.
  await runAuthMigrations();
  await ensureLocalNode(db);
}
