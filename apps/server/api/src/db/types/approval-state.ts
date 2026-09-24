/** Approval lifecycle for accounts an approval-gated provider creates (§6). */
export type ApprovalState = "approved" | "pending" | "rejected";

export const APPROVAL_STATES: readonly ApprovalState[] = ["approved", "pending", "rejected"];

/** Narrows anything a hand edit put in the column; falls back to approved. */
export function asApprovalState(value: string | null | undefined): ApprovalState {
  return value === "pending" || value === "rejected" ? value : "approved";
}
