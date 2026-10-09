import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { IdentityTable } from "@/db/types/identities.db-types.js";

/**
 * Principal encryption identities (public keys for sealed delivery).
 * Registering an existing principal ROTATES the key — old ciphertext becomes
 * unreadable to that principal by design (documented in the spec).
 */
export class IdentitiesRepository extends BaseRepository {
  /**
   * Inserts or rotates the principal's keypair registration. The
   * `signingPublicKey` slot (the machine's ES256 relay half, spec
   * 2026-10-08 §4.2) rotates WITH the encryption key in the same record, so a
   * caller always states it explicitly: null where the principal has no
   * signing identity (panes, users) or the agent has not reported one.
   */
  async register(input: {
    principalId: string;
    publicKey: string;
    signingPublicKey: string | null;
    displayName: string | null;
  }): Promise<IdentityTable> {
    await this.db
      .insertInto("identities")
      .values({
        principalId: input.principalId,
        publicKey: input.publicKey,
        signingPublicKey: input.signingPublicKey,
        displayName: input.displayName,
        registeredAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .onConflict((oc) =>
        oc.column("principalId").doUpdateSet({
          publicKey: input.publicKey,
          signingPublicKey: input.signingPublicKey,
          displayName: input.displayName,
          registeredAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        }),
      )
      .execute();
    return this.findByPrincipal(input.principalId) as Promise<IdentityTable>;
  }

  /**
   * Fill the principal's EMPTY signing slot (spec 2026-10-08 §4.3): a
   * compare-and-write that refuses to land once the slot holds ANY value, so
   * the anti-silent-rotation guard is structural in SQL rather than a
   * read-then-write the caller could race. The encryption `publicKey` and
   * `registeredAt` do not move - filling the signing half is not a rotation.
   * @returns true when THIS call wrote the bytes (false: the slot was, or
   *   concurrently became, non-empty, or the row does not exist)
   */
  async fillSigningPublicKey(principalId: string, signingPublicKey: string): Promise<boolean> {
    const res = await this.db
      .updateTable("identities")
      .set({ signingPublicKey })
      .where("principalId", "=", principalId)
      .where("signingPublicKey", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  /** Register only when absent, or fill a missing signing half while encryption still agrees. */
  async registerIfMatching(input: {
    principalId: string;
    publicKey: string;
    signingPublicKey: string;
    displayName: string | null;
  }): Promise<boolean> {
    await this.db
      .insertInto("identities")
      .values({ ...input, registeredAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .onConflict((oc) => oc.column("principalId").doNothing())
      .execute();
    await this.db
      .updateTable("identities")
      .set({ signingPublicKey: input.signingPublicKey })
      .where("principalId", "=", input.principalId)
      .where("publicKey", "=", input.publicKey)
      .where("signingPublicKey", "is", null)
      .execute();
    const standing = await this.findByPrincipal(input.principalId);
    return standing?.publicKey === input.publicKey && standing.signingPublicKey === input.signingPublicKey;
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
