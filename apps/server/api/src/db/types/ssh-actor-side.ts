/**
 * Which side of the human/agent boundary a resource was initiated by or is
 * currently held by (SSH feature, SSH-SUPPORT.md §3). One definition for the
 * initiator of a run, the initiator of a managed pane, and the control owner
 * of that pane: the three facts share the same value set and MUST stay one
 * union, or a reducer comparing "who opened it" against "who holds it" gets
 * two spellings of `agent` to drift.
 */
export type SshActorSide = "human" | "agent";

export const SSH_ACTOR_SIDES: readonly SshActorSide[] = ["human", "agent"];
