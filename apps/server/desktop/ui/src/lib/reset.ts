/**
 * The reset confirmation's decisions, pure (spec § 7.1). The display order
 * here is the deletion order in Rust § 7.2 step 5, because the screen shows
 * what will happen, in the order it will happen, and a screen that disagrees
 * with its own chain is the drift this file exists to prevent. The arming
 * compare is UX; the Rust compare against the same memoized hostname (R15)
 * is the gate, and its test name says so.
 */

interface StatusLike {
  configEnv?: { path: string; exists: boolean };
  paths?: { dataDir?: string; database?: string; logsDir?: string; nodeArtifacts?: string };
  listen?: { port?: number | null };
}

const isAbsolute = (p: unknown): p is string => typeof p === "string" && p.startsWith("/");

export function refusal(status: StatusLike | null | undefined): string | null {
  const p = status?.paths;
  // The listen port is part of the block the screen may promise from, exactly
  // as it is part of Rust's all-or-nothing plan (2026-09-13): a chain with no
  // port cannot prove the server died before it deletes, so an old server
  // without the `listen` report must meet this refusal here rather than a
  // Rust-side "nothing staged" surprise after the hostname is typed.
  const port = status?.listen?.port;
  const complete =
    p !== undefined &&
    isAbsolute(p.dataDir) &&
    isAbsolute(p.database) &&
    isAbsolute(p.logsDir) &&
    isAbsolute(p.nodeArtifacts) &&
    typeof status?.configEnv?.path === "string" &&
    typeof port === "number" &&
    port > 0;
  if (complete) return null;
  return (
    "This server does not report its data locations, so Reset refuses to guess at a filesystem. " +
    "Update the server to add the report, or remove the paths `subshell-server status` shows by hand."
  );
}

export function resetRows(status: StatusLike): { label: string; path: string }[] {
  const p = status.paths as NonNullable<StatusLike["paths"]>; // refusal() gates callers
  return [
    { label: "Database (users, sessions, API keys, the node signing keypair)", path: p.database as string },
    { label: "Pane logs (every transcript on disk)", path: p.logsDir as string },
    { label: "Node artifacts (the node binaries this plane serves)", path: p.nodeArtifacts as string },
    { label: "Instance data directory", path: p.dataDir as string },
    { label: "Configuration", path: status.configEnv?.path as string },
  ];
}

/**
 * The page-side mirror of Rust's consent compare, same exactness and one
 * added refusal it used to lack (PR review, fail-open): an EMPTY hostname is
 * a failed read on this machine, not a name - the empty box that used to
 * match it arms nothing, here and in Rust alike.
 */
export function armed(typed: string, hostname: string): boolean {
  return hostname !== "" && typed.trim() === hostname;
}

/**
 * The chain's live meter (spec 2026-09-13). A reset runs tens of seconds of
 * compiled-CLI spawns and tmux kills with nothing else to show, and a dead
 * button lettered "Resetting…" is indistinguishable from a hang — reported as
 * exactly that. `plan` is the page's own row (the arming round trip); the
 * other four are Rust's `ResetStep` wire words, and the containment in both
 * directions is pinned by `reset_steps_round_trip_and_mirror_the_page` in
 * `src-tauri/src/reset.rs`.
 */
export type StepKey = "plan" | "stop" | "panes" | "service" | "files";
export type StepState = "pending" | "running" | "done" | "failed";

export const RESET_STEPS: { key: StepKey; label: string }[] = [
  { key: "plan", label: "Reading this machine" },
  { key: "stop", label: "Stopping the server" },
  { key: "panes", label: "Closing the pane servers" },
  { key: "service", label: "Uninstalling the service" },
  { key: "files", label: "Deleting the data" },
];

/**
 * Whether the chain has touched anything yet — which is also which SCREEN the
 * reset view is on.
 *
 * Confirming and watching are two panes, not one growing one: a press
 * replaces the promises with the meter. Before the first step moves, the
 * confirmation is the whole screen; after it, the progress pane is.
 * @param steps - The meter's rows
 */
export function resetStarted(steps: Record<StepKey, StepState>): boolean {
  return RESET_STEPS.some(({ key }) => steps[key] !== "pending");
}

export function emptySteps(): Record<StepKey, StepState> {
  return { plan: "pending", stop: "pending", panes: "pending", service: "pending", files: "pending" };
}

/**
 * Whether a `desktop-reset-step` payload is words this meter knows. The event
 * comes from the same crate, but a page newer than the binary (or the reverse,
 * under `tauri dev` HMR) is this window's normal condition — an unknown word
 * drops silently rather than corrupting the row states.
 */
export function knownStep(step: unknown, state: unknown): step is StepKey {
  return (
    typeof step === "string" &&
    typeof state === "string" &&
    RESET_STEPS.some((s) => s.key === step) &&
    ["pending", "running", "done", "failed"].includes(state)
  );
}
