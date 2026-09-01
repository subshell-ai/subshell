import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Server } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { NodeRow } from "@/components/nodes/node-row";
import { SetupKeysSection } from "@/components/nodes/setup-keys-section";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useDeleteNode, useNodes } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { Node } from "@/types/node";

export const Route = createFileRoute("/nodes")({
  component: NodesPage,
});

/**
 * The node registry (spec 2026-08-31 §9): every node the caller owns or was
 * shared, plus the flow that enrolls new ones (Add-node → plaintext-once
 * setup key → install command). The node list polls at 3 s ONLY while the
 * add-node dialog is open, so enrollment feedback costs nothing at rest.
 */
function NodesPage() {
  const navigate = useNavigate();
  const deleteNode = useDeleteNode();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useNodes({ polling: dialogOpen });
  const [actionError, setActionError] = useState<string | null>(null);

  const nodes = data?.nodes ?? [];

  /** The node's config page (`/nodes/$id`, spec §10). */
  function goDetail(id: string) {
    void navigate({ to: "/nodes/$id", params: { id } });
  }

  async function remove(node: Node) {
    setActionError(null);
    const ok = await confirmAction({
      title: `Delete node "${node.name}"?`,
      description: "Its enrollment key is revoked and profiles pinned to it are unpinned.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteNode.mutateAsync(node.id);
    } catch (err) {
      // 409 NODE_RUNNING_SESSIONS: the backend message names the count and
      // the ?force=true path — surface it verbatim rather than re-wording it.
      setActionError(errMessage(err, "Failed to delete node"));
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Nodes"
        subtitle="Machines sessions can run on — this host plus enrolled agents"
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus /> Add node
          </Button>
        }
      />

      {actionError && <p className="text-destructive text-sm">{actionError}</p>}

      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}

      {/* A failed list load is not an empty account — say so, with a retry. */}
      {isError && (
        <ErrorBanner
          message="Couldn't load nodes."
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-inherit text-xs underline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          }
        />
      )}

      {!isLoading && !isError && nodes.length === 0 && (
        <EmptyState
          icon={Server}
          title="No nodes yet"
          description="Enroll another machine with a setup key to run sessions on it."
          actionLabel="Add your first node"
          onAction={() => setDialogOpen(true)}
        />
      )}

      {nodes.length > 0 && (
        <div className="space-y-3">
          {nodes.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              onOpenConfig={() => goDetail(node.id)}
              onShare={() => goDetail(node.id)}
              onDelete={() => void remove(node)}
            />
          ))}
        </div>
      )}

      <SetupKeysSection />

      <AddNodeDialog open={dialogOpen} onOpenChange={setDialogOpen} nodeCount={nodes.length} />
    </main>
  );
}
