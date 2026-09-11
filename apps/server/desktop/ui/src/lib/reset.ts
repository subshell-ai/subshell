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
}

const isAbsolute = (p: unknown): p is string => typeof p === "string" && p.startsWith("/");

export function refusal(status: StatusLike | null | undefined): string | null {
  const p = status?.paths;
  const complete =
    p !== undefined &&
    isAbsolute(p.dataDir) &&
    isAbsolute(p.database) &&
    isAbsolute(p.logsDir) &&
    isAbsolute(p.nodeArtifacts) &&
    typeof status?.configEnv?.path === "string";
  if (complete) return null;
  return (
    "This server does not report its data locations, so there is no list this screen can promise to delete. " +
    "Reset refuses to guess at a filesystem. Updating the server (the button this page offers when an update " +
    "is available) adds the report; otherwise remove the directories shown by `subshell-server status` by hand."
  );
}

export function resetRows(status: StatusLike): { label: string; path: string }[] {
  const p = status.paths as NonNullable<StatusLike["paths"]>; // refusal() gates callers
  return [
    { label: "Database (users, sessions, API keys, the node signing keypair)", path: p.database as string },
    { label: "Pane logs (every transcript on disk)", path: p.logsDir as string },
    { label: "Node artifacts (the agent binaries this plane serves)", path: p.nodeArtifacts as string },
    { label: "Instance data directory", path: p.dataDir as string },
    { label: "Configuration", path: status.configEnv?.path as string },
  ];
}

export function armed(typed: string, hostname: string): boolean {
  return typed.trim() === hostname;
}
