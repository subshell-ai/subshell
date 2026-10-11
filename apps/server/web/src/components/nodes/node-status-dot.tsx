import { cn, type Node, relativeElapsed } from "@internal/node-admin";

/**
 * The Nodes page's status mark: the 6px dot from the subshell state language
 * (`subshell-dot.tsx`) filling the node's two-state world — solid green online,
 * palette red offline (the 2026-09-24 operator ruling the subshell cards
 * already honor: unreachable is an error state, not a caution). It REPLACED
 * the text chip: a gray chip beside the gray OS chip was invisible, and an
 * operator watched a dead node that had stopped accepting credentials while a
 * re-registration sat offline for hours.
 *
 * Unlike the rail's dot (aria-hidden: the row text carries the state), this dot
 * IS the state carrier on this page — the word it once read is now only here,
 * so it announces itself and shows a title. No blink: a node is not "working".
 */
export function NodeStatusDot({ node }: { node: Node }) {
  const online = node.status === "online";
  const label = online
    ? "online"
    : node.lastSeenAt
      ? `offline · seen ${relativeElapsed(node.lastSeenAt)}`
      : "offline · never seen";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-destructive")}
    />
  );
}
