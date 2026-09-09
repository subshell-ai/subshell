import type { Kysely } from "kysely";

/**
 * Renames the control-plane host's node row from its original seed value to
 * "Server" (spec 2026-09-08).
 *
 * "Local" read as "the machine I am sitting at" to every user but the
 * operator — in the Nodes list and, because the launch surfaces took their
 * label from a hardcoded string, in every picker as well.
 *
 * The rewrite is unconditional and that is safe: the name was IMMUTABLE until
 * this release (`PATCH /api/nodes/:id` returned 400 for `kind: "local"`), so
 * the stored value is always still the seed and no admin's choice can be
 * clobbered. It is scoped by id AND kind, because a user's own enrolled
 * machine may legitimately be named "Local" and that is not ours to change.
 *
 * No unique-index hazard: `idx_nodes_owner_name` is per owner, and the
 * `system` user owns exactly this row — enrollment assigns the enrolling human
 * as owner. It also matches nothing on a fresh install, where the row is
 * seeded after migrations run.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db
    .updateTable("nodes")
    .set({ name: "Server" })
    .where("id", "=", "local")
    .where("kind", "=", "local")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .updateTable("nodes")
    .set({ name: "Local" })
    .where("id", "=", "local")
    .where("kind", "=", "local")
    .execute();
}
