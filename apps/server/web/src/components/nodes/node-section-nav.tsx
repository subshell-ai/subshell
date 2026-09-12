import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import type { NodeDetail } from "@/types/node";

/**
 * One node's sections (spec 2026-09-12, node half § 2).
 *
 * A strip under the page header rather than a group in the global rail: the
 * rail lists Nodes, one entry, because a fleet of thirty machines must not
 * become thirty rail entries. A node's sections belong to the node the way a
 * subshell's tabs belong to the subshell.
 *
 * **Three of the four are hidden for `local` and for a viewer who cannot
 * configure**, and that is the server's rule rather than this component's
 * guess: Service, Configuration and Logs all 400 on the control-plane host
 * (its own surface is Server Settings → Service) and 403 for a `view` grantee.
 * Rendering links that answer 403 would teach a person that the app is broken.
 */
export function NodeSectionNav({ node }: { node: NodeDetail }): JSX.Element {
  // `access` is the server's own word for this viewer, so the nav and the
  // routes cannot disagree about who sees what.
  const canConfigure = node.access === "owner" || node.access === "edit";
  const managed = node.kind === "agent" && canConfigure;

  const items: { to: string; label: string }[] = [
    { to: `/nodes/${node.id}`, label: "Overview" },
    ...(managed
      ? [
          { to: `/nodes/${node.id}/service`, label: "Service" },
          { to: `/nodes/${node.id}/config`, label: "Configuration" },
          { to: `/nodes/${node.id}/logs`, label: "Logs" },
        ]
      : []),
  ];

  if (items.length === 1) return <></>;

  return (
    <nav aria-label="Node sections" className="-mb-px flex gap-1 border-b">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          // `exact` on Overview only: without it the parent route matches every
          // child and two tabs read as current at once.
          activeOptions={{ exact: item.label === "Overview" }}
          className={cn(
            "border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm hover:text-foreground",
            "data-[status=active]:border-primary data-[status=active]:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
