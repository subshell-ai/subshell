import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { IdentityTable } from "@/db/types/identities.db-types.js";

/**
 * Principal encryption identities (public keys for sealed delivery).
 * Registering an existing principal ROTATES the key — old ciphertext becomes
 * unreadable to that principal by design (documented in the spec).
 */
export class IdentitiesRepository extends BaseRepository {
  /** Inserts or rotates the principal's keypair registration. */
  async register(input: {
    principalId: string;
    publicKey: string;
    displayName: string | null;
  }): Promise<IdentityTable> {
    await this.db
      .insertInto("identities")
      .values({
        principalId: input.principalId,
        publicKey: input.publicKey,
        displayName: input.displayName,
        registeredAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .onConflict((oc) =>
        oc.column("principalId").doUpdateSet({
          publicKey: input.publicKey,
          displayName: input.displayName,
          registeredAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        }),
      )
      .execute();
    return this.findByPrincipal(input.principalId) as Promise<IdentityTable>;
  }

  /** The principal's current identity, if registered. */
  async findByPrincipal(principalId: string): Promise<IdentityTable | undefined> {
    return this.db.selectFrom("identities").selectAll().where("principalId", "=", principalId).executeTakeFirst();
  }

  /** Batch lookup for the members roster join (principal → key, missing = undefined). */
  async findByPrincipals(principalIds: string[]): Promise<Map<string, IdentityTable>> {
    if (principalIds.length === 0) return new Map();
    const rows = await this.db.selectFrom("identities").selectAll().where("principalId", "in", principalIds).execute();
    return new Map(rows.map((r) => [r.principalId, r]));
  }
}
