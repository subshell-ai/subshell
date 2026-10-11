import type { Node } from "@internal/node-admin";
import { Button, confirmAction, errMessage, Input } from "@internal/node-admin";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeleteNode, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode, NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
import { filterNodes, NODE_FILTERS_OFF, type NodeFilters } from "@/lib/node-filter";

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
  // Page state, not URL — the home page's machine-filter precedent: filters
  // narrow BOTH list views and a back button is expected to leave them alone
  // (the view tab keeps the URL). (design 2026-10-10 §B)
  const [filters, setFilters] = useState<NodeFilters>(NODE_FILTERS_OFF);
  const visible = filterNodes(nodes, filters);

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
          // Always drawn (operator ruling 2026-09-24, reversing the earlier
          // "hidden, not disabled"): a hidden button makes the FEATURE look
          // missing; a dead one says the feature exists and names, in its
          // tooltip, who holds the switch. The tooltip's trigger is a wrapper
          // span rather than the button because the Button variant carries
          // `disabled:pointer-events-none` (node-admin's buttonVariants) —
          // that CSS, not a browser law, is what lets the pointer reach the
          // span beneath. Trim that clause and the tooltip silently dies in
          // every real browser while these tests stay green. Same `render`
          // mechanism the sidebar row uses to merge a tooltip onto an
          // existing element.
          mayAddNode ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus /> Add node
            </Button>
          ) : (
            <TooltipProvider delay={300}>
              <Tooltip>
                {/* Review finding I-1 (2026-09-24): hover alone is not a
                    carrier. A disabled <button> is not focusable, so the
                    SPAN takes the tab stop (the dead button cannot receive
                    focus, the span can, and focus opens the tooltip), and
                    `aria-describedby` names the sr-only copy for readers —
                    Base UI marks the trigger element, it does not wire the
                    association itself. */}
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the real control is a disabled <button>, which HTML removes from the tab order — without this wrapper's tab stop, a keyboard user cannot open the tooltip explaining WHY the button is dead. The span is a trigger carrier, not content. */}
                <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-describedby="add-node-why" />}>
                  <Button disabled>
                    <Plus /> Add node
                  </Button>
                </TooltipTrigger>
                {/* Same words the launch form uses for this gate (see
                    `NODE_ENROLLMENT_OFF_COPY`) — the tooltip is the Nodes
                    page's copy of that sentence, not a new one. */}
                <TooltipContent>{NODE_ENROLLMENT_OFF_COPY}</TooltipContent>
              </Tooltip>
              <span id="add-node-why" className="sr-only">
                {NODE_ENROLLMENT_OFF_COPY}
              </span>
            </TooltipProvider>
          )
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
        // The page-tab shape; it used to be spelled `className="w-fit"`,
        // which left the flex-1 equal-share fight to the layout (2026-09-25).
        fill={false}
      />

      {/* The toolbar, shown only when the current view has rows to narrow
          (the enrollment empty state owns the no-rows case, and the keys
          ledger has no nodes to filter). `type="search"` is what makes the
          Input a searchbox to AT — placeholder text is a visual affordance,
          not an accessible one. */}
      {active !== "keys" && nodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            placeholder="Search by name or hostname…"
            aria-label="Search nodes"
            className="max-w-sm"
          />
          {/* `items` on the Root is Base UI's label map — without it the
              trigger shows the raw value string (see ui/select.tsx header);
              this is how `routes/index.tsx` wires its own selects. */}
          <Select
            value={filters.status}
            onValueChange={(v) => setFilters((f) => ({ ...f, status: v as NodeFilters["status"] }))}
            items={[
              { value: "all", label: "All status" },
              { value: "online", label: "Online" },
              { value: "offline", label: "Offline" },
            ]}
          >
            <SelectTrigger aria-label="Filter by status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="online">Online</SelectItem>
              <SelectItem value="offline">Offline</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.access}
            onValueChange={(v) => setFilters((f) => ({ ...f, access: v as NodeFilters["access"] }))}
            items={[
              { value: "all", label: "All access" },
              { value: "yours", label: "Yours" },
              { value: "shared", label: "Shared" },
            ]}
          >
            <SelectTrigger aria-label="Filter by access" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All access</SelectItem>
              <SelectItem value="yours">Yours</SelectItem>
              <SelectItem value="shared">Shared</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {active === "keys" ? (
        <SetupKeysSection />
      ) : (
        <>
          {/* There used to be a PERMANENT sentence here, above every list.
              Gone (operator ruling 2026-09-24): the dead button's tooltip
              carries the why, and the empty state below says it to whoever
              has no rows — touch readers, who cannot hover, meet it there
              (review finding I-1). */}
          {actionError && <p className="text-destructive text-detail">{actionError}</p>}

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

          {/* The SECOND opener, gated with the first: a non-admin with no node
              visible to them sees `nodes.length === 0`, and an "Add your first
              node" button here would offer the dialog to exactly the viewer the
              setting targets — the bug this page shipped once. The action
              stays absent rather than disabled: a second dead button on one
              page is noise, and the header's says the reason. */}
          {!isLoading && !isError && nodes.length === 0 && (
            <EmptyState
              icon={Server}
              title="No nodes yet"
              description={
                mayAddNode
                  ? "Enroll another machine with a setup key to run subshells on it."
                  : NODE_ENROLLMENT_OFF_COPY
              }
              actionLabel={mayAddNode ? "Add your first node" : undefined}
              onAction={mayAddNode ? () => setDialogOpen(true) : undefined}
            />
          )}

          {/* Rows exist but none match — a DIFFERENT question than "No nodes
              yet" above (which means the account has nothing to narrow), so
              it gets its own state and one click back. */}
          {nodes.length > 0 && visible.length === 0 && (
            <EmptyState
              icon={Server}
              title="No nodes match"
              description="No node matches the current search and filters."
              actionLabel="Clear filters"
              onAction={() => setFilters(NODE_FILTERS_OFF)}
            />
          )}

          {visible.length > 0 &&
            (active === "list" ? (
              <NodeTable
                nodes={visible}
                onOpenConfig={goDetail}
                onShare={goDetail}
                onDelete={(node) => void remove(node)}
                onError={setActionError}
              />
            ) : (
              <div className="space-y-3">
                {visible.map((node) => (
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
