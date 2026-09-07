/** Lifecycle status of an agent subshell. */
export type SubshellStatus = "running" | "terminated";

export const SUBSHELL_STATUSES: readonly SubshellStatus[] = ["running", "terminated"];
