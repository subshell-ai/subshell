import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshGrantRequestStatus, SshGrantRequestTable, SshKeyGrantTable } from "@/db/types/ssh-grants.db-types.js";

/**
 * Repository for the grant tier (spec 2026-10-08 §6; migration 0050): the
 * standing key grants and the durable first-use approval queue. Every read
 * and write here is OWNER-SCOPED at the WHERE clause, mirroring the
 * saved-hosts ledger: a foreign row is not "forbidden", it is absent, and the
 * route renders absence as the 404 the ownership axis demands (docs/
 * security.md §3). No clock lives in the repository: callers pass their ISO
 * stamps, the same posture as `LedgerWrite.at` (0048).
 *
 * The insert shapes live HERE, beside the repository, not in the db-types
 * file (the task-6 note restated): both tables are full rows on every write,
 * the repository owns no defaults, and there is no partial vocabulary to
 * type. `host_pins` has no reader yet - the shape exists (0050) and T12
 * writes the capture logic; a repository for a table nothing reads yet is a
 * second thing to keep in sync.
 */

/** One full grant row as the two writers (approve, grants screen) compose it. */
export type NewSshKeyGrant = SshKeyGrantTable;

/** One full request row as {@link SshGrantsRepository.insertRequest} takes it. */
export type NewSshGrantRequest = SshGrantRequestTable;

export class SshGrantsRepository extends BaseRepository {
  /** Write a standing grant. The caller validated the row (cap, grammar, ids). */
  async insertGrant(grant: NewSshKeyGrant): Promise<void> {
    await this.db.insertInto("sshKeyGrants").values(grant).execute();
  }

  /** One of the owner's grants by id; a foreign id is indistinguishable from an absent one. */
  async getGrant(ownerUserId: string, grantId: string): Promise<SshKeyGrantTable | undefined> {
    return await this.db
      .selectFrom("sshKeyGrants")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("id", "=", grantId)
      .executeTakeFirst();
  }

  /**
   * The owner's grants for one key home - the whole launch-time match read.
   * The service does the selector matching (the glob policy is not SQL's);
   * the row count per owner per key home is small by construction.
   */
  async grantsFor(ownerUserId: string, keyHomeNodeId: string): Promise<SshKeyGrantTable[]> {
    return await this.db
      .selectFrom("sshKeyGrants")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("keyHomeNodeId", "=", keyHomeNodeId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /** The owner's grants for the screen, newest first. */
  async listGrants(ownerUserId: string): Promise<SshKeyGrantTable[]> {
    return await this.db
      .selectFrom("sshKeyGrants")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("createdAt", "desc")
      .execute();
  }

  /**
   * Apply an operator edit (name and/or selector), returning the row or
   * null for foreign-and-absent. `updatedAt` is the caller's stamp.
   */
  async updateGrant(
    ownerUserId: string,
    grantId: string,
    patch: { name?: string; resolvedSelector?: string; updatedAt: string },
  ): Promise<SshKeyGrantTable | undefined> {
    const { name, resolvedSelector, updatedAt } = patch;
    await this.db
      .updateTable("sshKeyGrants")
      .set({
        ...(name === undefined ? {} : { name }),
        ...(resolvedSelector === undefined ? {} : { resolvedSelector }),
        updatedAt,
      })
      .where("ownerUserId", "=", ownerUserId)
      .where("id", "=", grantId)
      .execute();
    return await this.getGrant(ownerUserId, grantId);
  }

  /**
   * Delete one of the owner's grants; false for foreign AND absent. The
   * caller (the revoke act) reaches the live relay AFTER this returns true -
   * the row going first is the ordering that makes a raced relay-open's
   * liveness re-check answer "gone".
   */
  async deleteGrant(ownerUserId: string, grantId: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("sshKeyGrants")
      .where("id", "=", grantId)
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }

  /** Record a first-use request. Only `insertRequest` writes `pending`. */
  async insertRequest(request: NewSshGrantRequest): Promise<void> {
    await this.db.insertInto("sshGrantRequests").values(request).execute();
  }

  /** One of the owner's requests by id; foreign is absent (the same 404). */
  async getRequest(ownerUserId: string, requestId: string): Promise<SshGrantRequestTable | undefined> {
    return await this.db
      .selectFrom("sshGrantRequests")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("id", "=", requestId)
      .executeTakeFirst();
  }

  /**
   * The OPEN question for one (owner, key home, selector): a standing
   * pending row whose deadline has not passed. A relaunch finds THIS row
   * (spec §6.2: "a re-launch simply finds the pending row") rather than
   * stacking a second approval and a second notification.
   */
  async findPendingRequest(
    ownerUserId: string,
    keyHomeNodeId: string,
    resolvedSelector: string,
    nowIso: string,
  ): Promise<SshGrantRequestTable | undefined> {
    return await this.db
      .selectFrom("sshGrantRequests")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("keyHomeNodeId", "=", keyHomeNodeId)
      .where("resolvedSelector", "=", resolvedSelector)
      .where("status", "=", "pending")
      .where("expiresAt", ">", nowIso)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
  }

  /** The owner's queue for the approvals screen: pending newest first, plus whatever statuses are asked. */
  async listRequests(
    ownerUserId: string,
    statuses: readonly SshGrantRequestStatus[] = ["pending"],
  ): Promise<SshGrantRequestTable[]> {
    return await this.db
      .selectFrom("sshGrantRequests")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("status", "in", statuses)
      .orderBy("createdAt", "desc")
      .execute();
  }

  /**
   * The compare-and-set answer: flip a request from `expected` to `next` only
   * if it still stands where the approver read it. False is the 409 the
   * screen renders (a second approver, or the sweep, beat this answer).
   */
  async markRequestStatus(
    ownerUserId: string,
    requestId: string,
    expected: SshGrantRequestStatus,
    next: SshGrantRequestStatus,
  ): Promise<boolean> {
    const res = await this.db
      .updateTable("sshGrantRequests")
      .set({ status: next })
      .where("id", "=", requestId)
      .where("ownerUserId", "=", ownerUserId)
      .where("status", "=", expected)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /**
   * The expiry sweep: mark every PAST-DEADLINE pending row `expired`.
   * Returns the count. Writes no audit row and no grant (spec §6.2:
   * "expiry writes nothing at all" - the row is the fact it was asked, the
   * status is the fact it went unanswered). Rows already terminal are
   * untouched; `nowIso` is the caller's clock.
   */
  async sweepExpiredRequests(nowIso: string): Promise<number> {
    const res = await this.db
      .updateTable("sshGrantRequests")
      .set({ status: "expired" })
      .where("status", "=", "pending")
      .where("expiresAt", "<=", nowIso)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n);
  }
}
