/**
 * The opaque push payload (spec invariant 6): sid + kind + origin, nothing
 * that names anything. Typed here once so the backend contract and the tap
 * handler share a shape.
 */
export interface SubshellNotifData {
  /** Subshell uuid — the only identifier that crosses the relay */
  sid?: string;
  /** Event class driving the generic body copy */
  kind?: "turn_complete" | "needs_attention" | "exited" | "crashed" | "crashed_final";
  /** Origin that sent it — future multi-instance routing hint */
  origin?: string;
}
