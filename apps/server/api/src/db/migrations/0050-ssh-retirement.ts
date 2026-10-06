import type { Kysely } from "kysely";

/**
 * SSH destination-product retirement (Workstream C, design 2026-10-05 §7,
 * migration 0050): the five tables the superseded destination-execution
 * product lived in drop HERE, as a real migration rather than a schema edit.
 *
 * `ssh_connections`, `ssh_grants`, `ssh_runs`, `ssh_panes`,
 * `ssh_terminal_execs` (and, with them, every index 0047/0048 created -
 * SQLite drops a table's indexes with the table): the replacement product
 * (SSH remote runtime sessions, migration 0049) shares NONE of these rows.
 * A session is a brokered destination runtime, its panes are ordinary panes
 * on a hidden `runtime` node, and its open carries reviewed destination facts
 * in the request, never a stored connection. Nothing reads these tables
 * after this commit, and a dead security gate is worse than no gate: the
 * plan's disposition table retires the doors deliberately.
 *
 * 0047 and 0048 are NOT touched (Kysely is forward-only; an already-applied
 * migration must keep re-running identically on an older database on its way
 * up). A fresh install therefore CREATEs the five tables and drops them one
 * migration later; the chain stays contiguous, which is what the backup
 * restore's migration math reads. The drop is `IF EXISTS` for the same
 * reason the anchor test works: a restored snapshot missing ONLY this row
 * re-runs it cleanly whether or not its tables are present.
 *
 * The data is gone by decision, not accident: single-user instances, the
 * feature never released (PR #330 explicitly must not merge the old model),
 * and the pane logs / node-side stores never belonged to these tables.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ssh_terminal_execs").ifExists().execute();
  await db.schema.dropTable("ssh_panes").ifExists().execute();
  await db.schema.dropTable("ssh_runs").ifExists().execute();
  await db.schema.dropTable("ssh_grants").ifExists().execute();
  await db.schema.dropTable("ssh_connections").ifExists().execute();
  // The child order is deliberate (grants/runs/panes reference connections);
  // SQLite enforces FKs per statement, so dropping the leaf tables first
  // keeps every cascade satisfied even with foreign_keys pragma ON.
}

/**
 * No down half. This migration deletes the tables of a product that will not
 * come back; recreating their grammar to "roll back" would resurrect doors
 * the retirement closed on purpose (and Kysely never runs `down` in this
 * app - the backup path restores whole snapshots, see docs).
 */
export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error("0050-ssh-retirement is not reversible: the destination product's doors stay closed");
}
