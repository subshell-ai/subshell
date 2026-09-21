import type { NodeDetail } from "@internal/node-admin";
import { useNode } from "@internal/node-admin";
import type { JSX, ReactNode } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { NodeSectionNav } from "@/components/nodes/node-section-nav";
import { PageHeader } from "@/components/page-header";

/**
 * The frame every node section shares: the load, the header, and the nav.
 *
 * Extracted when `/nodes/$id` became four routes (spec 2026-09-12, node half
 * § 2) — the alternative was four copies of the same 404 handling, and a 404
 * rendered four slightly different ways is how a page starts leaking which ids
 * exist.
 *
 * The child is a FUNCTION of the loaded node rather than a `ReactNode`, so a
 * section never has to re-handle "not loaded yet" or narrow `undefined` again.
 * The Overview section passes its own header actions (rename, share, delete);
 * the others take the plain title, because those actions belong to the node
 * rather than to a section and showing them four times would invite the
 * question of whether they differ.
 */
export function NodePageShell({
  id,
  title,
  subtitle,
  action,
  children,
}: {
  id: string;
  /** Overrides the node's name — the Overview page passes an editable field. */
  title?: ReactNode;
  subtitle?: string;
  action?: (node: NodeDetail) => ReactNode;
  children: (node: NodeDetail) => ReactNode;
}): JSX.Element {
  const node = useNode(id);

  if (node.isError) {
    // Absent and invisible collapse to one 404 server-side — say the same
    // thing here so the page never leaks which ids exist.
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <PageHeader title="Node" subtitle="Machine details" />
        <ErrorBanner message="That node does not exist, or is not shared with you." className="rounded-md border" />
      </main>
    );
  }

  const n = node.data;
  if (!n) {
    return (
      <main className="mx-auto w-full max-w-4xl p-6">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title={title ?? n.name}
        subtitle={subtitle ?? (n.kind === "local" ? "The control-plane host" : (n.hostname ?? "Enrolled node"))}
        action={action?.(n)}
      />
      <NodeSectionNav node={n} />
      {children(n)}
    </main>
  );
}
