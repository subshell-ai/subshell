/** Lifecycle status of an agent session. */
export type SessionStatus = "running" | "terminated";

export const SESSION_STATUSES: readonly SessionStatus[] = ["running", "terminated"];
