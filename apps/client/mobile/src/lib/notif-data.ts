/**
 * The opaque push payload (spec invariant 6): sid + kind + origin, nothing
 * that names anything. Typed here once so the backend contract and the tap
 * handler share a shape.
 */
export interface SubshellNotifData {
  /** Subshell uuid (a `grant_approval` push carries the grant REQUEST uuid) */
  sid?: string;
  /** Event class driving the generic body copy and the tap's destination */
  kind?: "turn_complete" | "needs_attention" | "exited" | "crashed" | "crashed_final" | "grant_approval";
  /** Origin that sent it — future multi-instance routing hint */
  origin?: string;
}
