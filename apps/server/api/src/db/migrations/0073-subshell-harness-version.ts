import type { Kysely } from "kysely";

/**
 * The harness CLI version a subshell was launched on (issue #250).
 *
 * Written at every spawn from the machine that answered `<binary> --version`,
 * parsed by the plugin on the control plane. NULL on rows that predate the
 * column, and on a launch whose version could not be read — an absent fact,
 * never a guess.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").addColumn("harness_version", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("harness_version").execute();
}
