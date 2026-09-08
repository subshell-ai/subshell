/** Placeholder name for a fresh workspace, e.g. `Aug 28, 4:45 PM`. Named in-place inside the workspace afterwards. */
export function defaultWorkspaceName(): string {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return stamp;
}
