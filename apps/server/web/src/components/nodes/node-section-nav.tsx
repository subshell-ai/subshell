import type { NodeDetail } from "@internal/node-admin";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { JSX } from "react";
import { Segmented } from "@/components/ui/segmented";

type Section = "overview" | "service" | "logs";

/**
 * The visibility rule for the two DAEMON sections: the nav hides their pills
 * by it and the section routes redirect by it. The node's RULES (allowlist,
 * server URL) are cards on the Overview now, not a tab, and each gates
 * itself.
 *
 * It is the server's rule rather than this component's guess: Service and
 * Logs 400 on the control-plane host (its own surface is Server Settings →
 * Service) and 403 for a `view` grantee. Rendering, or deep-linking, what
 * the route refuses teaches a person the app is broken; `/nodes/local/service`
 * answering a LIVE control-plane host with "this node is offline" is the
 * worst case, which is why the pages redirect to the Overview rather than
 * merely hiding the pill. The server still enforces the refusal; this only
 * keeps the page honest about it.
 *
 * `access` is the server's own word for this viewer, so nav and routes
 * cannot disagree about who sees what.
 */
export function managesNodeSections(node: NodeDetail): boolean {
  return node.kind === "agent" && (node.access === "owner" || node.access === "edit");
}

/**
 * One node's sections (spec 2026-09-12, node half § 2).
 *
 * A group under the page header rather than a group in the global rail: the
 * rail lists Nodes, one entry, because a fleet of thirty machines must not
 * become thirty rail entries. A node's sections belong to the node the way a
 * subshell's tabs belong to the subshell. Which sections show is
 * {@link managesNodeSections} — and the section ROUTES hide by that same rule
 * too, because a hidden pill is not a gated URL.
 *
 * The shape is the app's content-sized `Segmented` group, the same one the
 * Nodes page uses for Tiles/List/Keys and the settings pages use for their
 * tabs (design-system.md: tab groups are content-sized, operator's rule
 * 2026-09-25). It replaced an underline tab strip on 2026-10-09: the strip's
 * barely-visible bottom borders on the dark page read as a rendering defect,
 * and the app had ONE tab-group vocabulary elsewhere to join. Like the two
 * precedents (the Nodes page's view switch, the settings tabs) the group
 * carries its own accessible name; a wrapping `<nav>` landmark is what the
 * LINK strip needed and would announce the same label twice over the button
 * group. The sections stay URL-driven (deep links and redirects unchanged):
 * the active choice is derived from the pathname, and choosing navigates, so
 * the control and the address can never disagree.
 */
export function NodeSectionNav({ node }: { node: NodeDetail }): JSX.Element | null {
  const managed = managesNodeSections(node);
  const location = useLocation();
  const navigate = useNavigate();

  // One section is not a nav. A `view` grantee and the `local` host (whose
  // daemon tabs have no meaning there, Server Settings being its half) see
  // only Overview, and a single option inside a pill looks like a control
  // that does nothing.
  if (!managed) return null;

  const base = `/nodes/${node.id}`;
  // Exact-suffix reading, replacing the underline strip's `activeOptions`
  // load-bearingness: Overview is active only on the bare base path, so the
  // Overview pill and a section pill can never both light (flat siblings,
  // segment-prefix matching — the same trap the old `exact` pinned;
  // node-section-nav.test.tsx pins this reading per URL).
  const section: Section =
    location.pathname === `${base}/service` ? "service" : location.pathname === `${base}/logs` ? "logs" : "overview";

  return (
    <Segmented<Section>
      ariaLabel="Node sections"
      fill={false}
      value={section}
      options={[
        { value: "overview", label: "Overview" },
        { value: "service", label: "Service" },
        { value: "logs", label: "Logs" },
      ]}
      onChange={(next) => {
        // The already-lit pill re-navigates to its own URL, as the retired
        // Links and the settings tabs did; TanStack pushes the same-URL entry
        // and the render is unchanged. Guarding it is polish neither
        // precedent spends.
        if (next === "overview") void navigate({ to: "/nodes/$id", params: { id: node.id } });
        else if (next === "service") void navigate({ to: "/nodes/$id/service", params: { id: node.id } });
        else void navigate({ to: "/nodes/$id/logs", params: { id: node.id } });
      }}
    />
  );
}
