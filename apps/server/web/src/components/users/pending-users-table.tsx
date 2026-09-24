import { Badge, Button, errMessage } from "@internal/node-admin";
import { useRef, useState } from "react";
import { type PendingUserRow, useSetUserApproval } from "@/hooks/use-users-pending";

/**
 * The approval queue on `/settings/users?tab=pending` (spec 2026-09-24 §6):
 * every arrival a door let through who is not a member yet, newest first.
 *
 * A row leaves here only by an admin's decision: approving makes the person a
 * member (they surface in the Members tab), rejecting keeps them OUT of the
 * members list but IN this queue — Rejected rows stay on purpose, so the
 * record of who knocked survives and an admin can change their mind. There is
 * therefore no delete affordance anywhere in this table, and a Rejected row
 * offers only Approve: rejecting it again would rewrite the state it already
 * has.
 *
 * Both buttons are one PATCH each and no dialog: neither locks anyone out or
 * destroys anything. The server's refusal on an already-approved target
 * (409 APPROVAL_NOOP) arrives as its own sentence and is shown on the row
 * that asked (with the app-wide ApiError prefix, as everywhere else); row
 * errors retire after 8 s, the users and providers rows' discipline — a
 * refusal kept on screen past the moment it described becomes a second,
 * wrong state.
 *
 * The Provider column resolves the door NAME the queue read carries live;
 * null means the door has since been removed, which renders as a standing
 * label rather than vanishing the row — the queue is the record of who knocked
 * at a door this instance used to have.
 */
export function PendingUsersTable({ rows }: { rows: readonly PendingUserRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pr-4 pb-2 font-strong">Name</th>
            <th className="pr-4 pb-2 font-strong">Email</th>
            <th className="pr-4 pb-2 font-strong">Provider</th>
            <th className="pr-4 pb-2 font-strong">Arrived</th>
            <th className="pr-4 pb-2 font-strong">Status</th>
            <th className="pb-2 text-right font-strong" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <PendingRow key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PendingRow({ row }: { row: PendingUserRow }) {
  const approval = useSetUserApproval();
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Shows a refusal and schedules its retirement, clearing any earlier one's
   * timer so a second error cannot be erased by the first error's callback. */
  function reportError(message: string): void {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => setError(null), 8000);
  }

  async function decide(approvalState: "approved" | "rejected"): Promise<void> {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
    try {
      await approval.mutateAsync({ id: row.id, approvalState });
    } catch (err) {
      // The 409 sentence ("that account is already approved…") is the one
      // explanation of the rule; rendering the server's wording unchanged —
      // with only the app-wide ApiError prefix, as everywhere else — keeps
      // it on the side that enforces it.
      reportError(errMessage(err, "Could not record the decision"));
    }
  }

  const busy = approval.isPending;
  const rejected = row.approvalState === "rejected";

  return (
    <tr className="border-b align-middle last:border-0">
      {/* A door arrival may have carried no name; the email still identifies
          the person, so the empty name reads as "—" rather than a blank. */}
      <td className="py-2 pr-4">{row.name || "—"}</td>
      <td className="py-2 pr-4">{row.email}</td>
      <td className="py-2 pr-4">
        {row.providerName ? (
          <Badge variant="default">{row.providerName}</Badge>
        ) : (
          <span className="text-detail text-muted-foreground">Removed provider</span>
        )}
      </td>
      <td className="py-2 pr-4 text-muted-foreground">
        {/* Null arrival is a resolved rejection's answer: the stamp cleared
            when the row left pending. */}
        {row.arrivedAt ? new Date(row.arrivedAt).toLocaleString() : "—"}
      </td>
      <td className="py-2 pr-4">
        {/* Pending needs no badge: the whole tab is the pending list. Rejected
            is the exception the queue holds, so it is the state that speaks. */}
        {rejected && <Badge variant="warning">Rejected</Badge>}
      </td>
      <td className="py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          {error && (
            <span role="alert" className="text-destructive text-detail">
              {error}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("approved")}
            aria-label={`Approve ${row.email}`}
          >
            Approve
          </Button>
          {/* A Rejected row is already rejected: the second button would
              rewrite the state it has, so only the way out is offered. */}
          {!rejected && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void decide("rejected")}
              aria-label={`Reject ${row.email}`}
            >
              Reject
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
