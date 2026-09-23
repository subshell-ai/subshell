import type { Node } from "@internal/node-admin";
import { Button, confirmAction, errMessage } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, LayoutGrid, List, Plus, Server } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { NodeListRow } from "@/components/nodes/node-list-row";
import { NodeTable } from "@/components/nodes/node-table";
import { SetupKeysSection } from "@/components/nodes/setup-keys-section";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/ui/segmented";
import { useDeleteNode, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode } from "@/lib/node-enrollment";

/**
 * The page's three views, keyed in the URL. Order is the tabs' order.
 *
 * The iconography and verbiage are the SUBSHELLS page's (operator's ask,
 * 2026-09-22): same `LayoutGrid`/"Tiles" and `List`/"List" pair with their
 * "… view" aria-labels, so one vocabulary names "which shape is the list in"
 * across the two lists rather than "Cards/Table" here and "Tiles/List"
 * there. `tiles` is the default, so it is the ABSENCE of `?tab` (the same
 * reason `/settings/logs` omits its System tab): the plain `/nodes` path is
 * the card list's address, not one spelling of it plus a redundant
 * `?tab=tiles`.
 */
const NODES_TABS = [
  { value: "tiles", label: "Tiles", icon: <LayoutGrid className="h-4 w-4" />, ariaLabel: "Tiled view" },
  { value: "list", label: "List", icon: <List className="h-4 w-4" />, ariaLabel: "List view" },
  { value: "keys", label: "Keys", icon: <KeyRound className="h-4 w-4" />, ariaLabel: "Setup keys" },
] as const;

type NodesTab = (typeof NODES_TABS)[number]["value"];

export const Route = createFileRoute("/nodes")({
  component: NodesPage,
  validateSearch: (search: Record<string, unknown>): { tab?: NodesTab } =>
    search.tab === "list" || search.tab === "keys" ? { tab: search.tab } : {},
});

/**
 * The node registry (spec 2026-08-31 §9): every node the caller owns or was
 * shared, plus the flow that enrolls new ones (Add-node → plaintext-once
 * setup key → install command). The node list polls at 3 s ONLY while the
 * add-node dialog is open, so enrollment feedback costs nothing at rest.
 *
 * The list has two views and the enrollment keys are their own surface, all
 * behind one grouped tab (operator's ask, 2026-09-22): a card list to scan a
 * few machines with their harness chips, a table to line the fleet up column
 * for column, and the setup-key ledger that used to sit below the list on
 * every visit. The tab is URL state (Cards = the plain path), so a link or a
 * back button lands where it names.
 */
function NodesPage() {
  const navigate = Route.useNavigate();
  const { tab } = Route.useSearch();
  const active: NodesTab = tab ?? "tiles";
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

  function goTab(next: NodesTab) {
    void navigate({ search: next === "tiles" ? {} : { tab: next } });
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
        subtitle="Nodes allow you to run subshells on other machines"
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

      {/* `w-fit`: the fieldset is a block-level `flex`, so as a direct child of
        `<main>` it would stretch the three tabs across the whole page width —
        a segmented control is a switch between named states, not a toolbar,
        so it hugs its labels (operator's ask, 2026-09-22). */}
      <Segmented
        ariaLabel="Nodes view"
        options={[...NODES_TABS]}
        value={active}
        onChange={(next) => goTab(next)}
        className="w-fit"
      />

      {active === "keys" ? (
        <SetupKeysSection />
      ) : (
        <>
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

          {nodes.length > 0 &&
            (active === "list" ? (
              <NodeTable
                nodes={nodes}
                onOpenConfig={goDetail}
                onShare={goDetail}
                onDelete={(node) => void remove(node)}
                onError={setActionError}
              />
            ) : (
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
            ))}
        </>
      )}

      <AddNodeDialog open={dialogOpen} onOpenChange={setDialogOpen} nodeCount={nodes.length} />
    </main>
  );
}
