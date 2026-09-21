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
 * subshell's tabs belong to the subshell. Which sections show is the
 * predicate below — and the section ROUTES hide by that same predicate too,
 * because a hidden link is not a gated URL.
 */
/**
 * The visibility rule for the two DAEMON sections (Service, Logs) and the
 * narrower half of `managesNodeConfig` — the nav hides those links by it,
 * and the section routes redirect by it.
 *
 * It is the server's rule rather than this component's guess: Service and
 * Logs 400 on the control-plane host (its own surface is Server Settings →
 * Service) and 403 for a `view` grantee. Rendering — or deep-linking — what
 * the route refuses teaches a person the app is broken; `/nodes/local/service`
 * answering a LIVE control-plane host with "this node is offline" is the
 * worst case, which is why the pages redirect to the Overview rather than
 * merely hiding the tab. The server still enforces the refusal — this only
 * keeps the page honest about it.
 *
 * `access` is the server's own word for this viewer, so nav and routes
 * cannot disagree about who sees what.
 */
export function managesNodeSections(node: NodeDetail): boolean {
  return node.kind === "agent" && (node.access === "owner" || node.access === "edit");
}

/**
 * Whether this viewer sees the CONFIGURATION section — a wider set than
 * {@link managesNodeSections}, deliberately.
 *
 * Service and Logs drive the agent DAEMON, which the control-plane host does
 * not have (its half is Server Settings), so those stay agent-only. But
 * Configuration holds the DIRECTORY ALLOWLIST, and that rule exists for
 * `local` too — it is the node's own launch restriction, spec 2026-09-05,
 * and hiding it made the control-plane host's allowlist uneditable from the
 * plane that enforces it. `canManage` is the server's word for who may write
 * it (admin on `local`, owner on an agent), so an admin gets exactly the one
 * tab whose cards the routes will answer.
 *
 * The Server-URL card stays agent-only IN the page: repointing is a daemon
 * concept; the host is the server.
 */
export function managesNodeConfig(node: NodeDetail): boolean {
  return managesNodeSections(node) || (node.kind === "local" && node.canManage);
}

export function NodeSectionNav({ node }: { node: NodeDetail }): JSX.Element | null {
  const managed = managesNodeSections(node);
  const config = managesNodeConfig(node);

  const items: { to: string; label: string }[] = [
    { to: `/nodes/${node.id}`, label: "Overview" },
    ...(managed ? [{ to: `/nodes/${node.id}/service`, label: "Service" }] : []),
    ...(config ? [{ to: `/nodes/${node.id}/config`, label: "Configuration" }] : []),
    ...(managed ? [{ to: `/nodes/${node.id}/logs`, label: "Logs" }] : []),
  ];

  // One section is not a nav. A `view` grantee sees only Overview, and a
  // single tab above it would look like a control that does nothing.
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
