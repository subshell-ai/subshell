import type { NodeDetail } from "@internal/node-admin";
import { cn } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";

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
/**
 * The ONE visibility rule for the three managed sections — the nav hides
 * their links by it, and the section routes themselves redirect by it.
 *
 * Hiding the link is not gating the URL: since the sections are real
 * top-level routes, `/nodes/local/service` is reachable by typing, and it
 * must answer with the Overview the nav shows rather than a card whose
 * route 400s (or, worse, with "this node is offline" about a live
 * control-plane host). The server still enforces the refusal — this only
 * keeps the page honest about it.
 *
 * `access` is the server's own word for this viewer, so nav and routes
 * cannot disagree about who sees what.
 */
export function managesNodeSections(node: NodeDetail): boolean {
  return node.kind === "agent" && (node.access === "owner" || node.access === "edit");
}

export function NodeSectionNav({ node }: { node: NodeDetail }): JSX.Element | null {
  const managed = managesNodeSections(node);

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

  // One section is not a nav. `local` and a `view` grantee see only Overview,
  // and a single tab above it would look like a control that does nothing.
  if (items.length === 1) return null;

  return (
    <nav aria-label="Node sections" className="-mb-px flex gap-1 border-b">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          // `exact` on Overview only — and it is load-bearing for FLAT
          // siblings too: TanStack's default active match is segment-prefix,
          // so `/nodes/$id` matches while `/nodes/$id/service` is mounted,
          // and without `exact` the Overview tab and the section tab both
          // read as current. (The old reason — parent/child nesting — is
          // gone; deleting this on that assumption would double-highlight.)
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
