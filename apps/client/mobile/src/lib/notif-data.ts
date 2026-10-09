/**
 * The opaque push payload (spec invariant 6): sid + kind + origin, nothing
 * that names anything. Typed here once so the backend contract and the tap
 * handler share a shape.
 */
export interface SubshellNotifData {
  /** Subshell uuid */
  sid?: string;
  /** Event class driving the generic body copy and the tap's destination (the server's NotifyKind, spelled here) */
  kind?: "turn_complete" | "needs_attention" | "exited" | "crashed" | "crashed_final" | "maintenance";
  /** Origin that sent it — future multi-instance routing hint */
  origin?: string;
}
