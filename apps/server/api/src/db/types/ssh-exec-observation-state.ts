/**
 * Observation state of a terminal-exec record (SSH-SUPPORT.md §3, "Existing
 * exec_in_terminal"). The exec's truth is the MARKER, and the marker can
 * arrive late, never, or after the pane restarted - so the state is a fact
 * about OBSERVATION, not about the command.
 *
 * - `outstanding`: typed, waiting; a caller's wait timeout leaves it HERE
 *   (the reservation stays active, bounded marker observation continues).
 * - `completed`: the marker was seen; `exit_code` carries its rc.
 * - `unknown`: observation was LOST (pane restart, node blip past the record
 *   TTL, or a restart during observation). Never renamed to failed or
 *   completed; until human recovery or pane restart, it refuses further
 *   automated exec on that pane.
 */
export type SshExecObservationState = "outstanding" | "completed" | "unknown";

export const SSH_EXEC_OBSERVATION_STATES: readonly SshExecObservationState[] = ["outstanding", "completed", "unknown"];
