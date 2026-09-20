import type { Node } from "@internal/node-admin";
import { Button, confirmAction, errMessage } from "@internal/node-admin";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Server } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { NodeListRow } from "@/components/nodes/node-list-row";
import { SetupKeysSection } from "@/components/nodes/setup-keys-section";
import { PageHeader } from "@/components/page-header";
import { useDeleteNode, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode } from "@/lib/node-enrollment";

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
  // Whether to OFFER adding a node — `lib/node-enrollment.ts` carries the
  // rule and why the unknown case reads as allowed. The route is the gate.
  const { data: publicSettings } = usePublicSettings();
  const mayAddNode = canAddNode(publicSettings);
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
      description: "Its enrollment key is revoked.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteNode.mutateAsync(node.id);
    } catch (err) {
      // 409 NODE_RUNNING_SUBSHELLS: the backend message names the count and
      // the ?force=true path — surface it verbatim rather than re-wording it.
      setActionError(errMessage(err, "Failed to delete node"));
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Nodes"
        subtitle="Machines subshells can run on: the server plus enrolled nodes"
        action={
          // Hidden, not disabled: a non-admin on an instance where adding is
          // off cannot make this work, and a greyed control they can never
          // use is a worse answer than the sentence below saying who can.
          mayAddNode ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus /> Add node
            </Button>
          ) : undefined
        }
      />

      {/* Only where the list has rows — the empty state says it itself, and
          two copies of the same sentence on one screen is how a page stops
          being read. */}
      {!mayAddNode && nodes.length > 0 && (
        <p className="text-muted-foreground text-sm">
          An admin has turned off adding nodes on this instance. Ask one to add a machine for you.
        </p>
      )}

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
              className="h-auto p-0 text-detail text-inherit underline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          }
        />
      )}

      {/* The SECOND opener. Gating only the header button left this one
          offering the dialog to exactly the viewer the setting targets: a
          non-admin with no node visible to them sees `nodes.length === 0`,
          presses "Add your first node", and gets a 403 — which is the thing
          this page states twice that it does not do. */}
      {!isLoading && !isError && nodes.length === 0 && (
        <EmptyState
          icon={Server}
          title="No nodes yet"
          description={
            mayAddNode
              ? "Enroll another machine with a setup key to run subshells on it."
              : "An admin has turned off adding nodes on this instance. Ask one to add a machine for you."
          }
          actionLabel={mayAddNode ? "Add your first node" : undefined}
          onAction={mayAddNode ? () => setDialogOpen(true) : undefined}
        />
      )}

      {nodes.length > 0 && (
        <div className="space-y-3">
          {nodes.map((node) => (
            <NodeListRow
              key={node.id}
              node={node}
              onOpenConfig={() => goDetail(node.id)}
              onShare={() => goDetail(node.id)}
              onDelete={() => void remove(node)}
              onError={setActionError}
            />
          ))}
        </div>
      )}

      <SetupKeysSection />

      <AddNodeDialog open={dialogOpen} onOpenChange={setDialogOpen} nodeCount={nodes.length} />
    </main>
  );
}
