import type { SubshellTable } from "@/db/types/subshells.db-types.js";

/**
 * The two facts {@link paneInputAllowed} reads: the row's snapshot column (the
 * kind fact) and the owner. `SubshellTable` is assignable to it; the narrow
 * shape lets the WS path and tests hand over a partial row without pulling the
 * whole record into the predicate's contract.
 */
export type PaneInputRow = Pick<SubshellTable, "ssh" | "userId">;

/**
 * The owner-only input rule for ssh panes (spec 2026-10-07 §5.4 / plan
 * decision 5). It answers ONE question so every input door (REST input, exec,
 * MCP-via-REST, the WS keystroke) asks it the same way:
 *
 * - An ordinary pane (`ssh === null`) is admitted unconditionally. This
 *   predicate is the ssh carve-out ONLY; the grant logic (`#gate` for REST, the
 *   attach resolver for WS) decides edit/view for ordinary panes exactly as
 *   before, and this predicate never narrows it.
 * - An ssh pane admits input ONLY from its owner account, and NEVER from a
 *   bearer machine credential. The second half is why `bearerActor` is a
 *   separate input and not folded into the id comparison: raw REST resolves a
 *   pane's OWN subshell key as its owner (boost and shares off), so a bare
 *   `actorUserId === row.userId` would let an ssh pane type into itself — the
 *   exact slip decision 5 closes. A system key resolves through the human gate
 *   as the `system` service user (never the row's owner), so it is refused by
 *   the id test regardless; `bearerActor` makes the refusal explicit.
 *
 * The decision is keyed to the COLUMN'S PRESENCE (`subshells.ssh`, migration
 * 0048), the pane's kind fact — not its content. Snapshot validation belongs
 * to the launch boundary, not the input door.
 *
 * @param row - The subshell's kind + owner (a full `SubshellTable` fits)
 * @param actorUserId - The account the caller resolves as (row's owner for a
 *   bearer subshell key on raw REST; the row's owner for a scoped WS token too,
 *   which is why `bearerActor` must carry the machine-ness)
 * @param bearerActor - True for any machine credential: a `subshell-key` or
 *   `system-key` on REST, or a scoped WS token. False for a human (cookie
 *   session, or a cookie-minted unscoped WS token).
 * @returns True when input may proceed on kind grounds; the caller has ALREADY
 *   applied its own grant/visibility gate
 */
export function paneInputAllowed(row: PaneInputRow, actorUserId: string, bearerActor: boolean): boolean {
  // Ordinary pane: the ssh rule is silent, the existing grant logic governs.
  if (row.ssh === null) return true;
  // An ssh pane: owner account only, and never a bearer machine credential.
  return !bearerActor && actorUserId === row.userId;
}
