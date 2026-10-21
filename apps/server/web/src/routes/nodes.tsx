import type { Node } from "@internal/node-admin";
import { Button, Input, NODES_QUERY_KEY } from "@internal/node-admin";
import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, List, Plus, Server } from "lucide-react";
import { useState } from "react";
import { DashboardPage } from "@/components/dashboard-page";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { LoadingCard } from "@/components/loading-card";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { DeleteNodeDialog } from "@/components/nodes/delete-node-dialog";
import { NodeSharingDialog } from "@/components/nodes/node-sharing-dialog";
import { NodeTable } from "@/components/nodes/node-table";
import { SetupKeysSection } from "@/components/nodes/setup-keys-section";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilteredList } from "@/hooks/use-filtered-list";
import { useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode, NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
import { NODE_FILTERS_OFF, type NodeFilters } from "@/lib/node-filter";

/** The node table is the default; setup keys have a separate URL tab. */
const NODES_TABS = [
  { value: "list", label: "List", icon: <List className="h-4 w-4" />, ariaLabel: "List view" },
  { value: "keys", label: "Keys", icon: <KeyRound className="h-4 w-4" />, ariaLabel: "Setup keys" },
] as const;

type NodesTab = (typeof NODES_TABS)[number]["value"];

export const Route = createFileRoute("/nodes")({
  component: NodesPage,
  validateSearch: (search: Record<string, unknown>): { tab?: NodesTab } =>
    search.tab === "list" || search.tab === "keys" ? { tab: search.tab } : {},
});

/** Poll for newly enrolled nodes only while the add-node dialog is open. */
function NodesPage() {
  const navigate = Route.useNavigate();
  const { tab } = Route.useSearch();
  const active: NodesTab = tab ?? "list";
  const [deletingNode, setDeletingNode] = useState<Node | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  // Whether to OFFER adding a node — `lib/node-enrollment.ts` carries the
  // rule and why the unknown case reads as allowed. The route is the gate.
  const { data: publicSettings } = usePublicSettings();
  const mayAddNode = canAddNode(publicSettings);
  const { data, isLoading, isError, refetch } = useNodes({ polling: dialogOpen });
  const [actionError, setActionError] = useState<string | null>(null);

  const nodes = data?.nodes ?? [];
  // Filters narrow the table without changing the setup keys view.
  const [filters, setFilters] = useState<NodeFilters>(NODE_FILTERS_OFF);
  const q = useDebouncedValue(filters.query.trim());
  const results = useFilteredList<{ nodes: Node[] }>(
    NODES_QUERY_KEY,
    "/api/nodes",
    {
      q,
      status: filters.status === "all" ? undefined : filters.status,
      access: filters.access === "all" ? undefined : filters.access,
    },
    { refetchInterval: dialogOpen ? 3000 : false },
  );
  const visible = results.data?.nodes ?? [];
  const sharingNode = nodes.find((node) => node.id === sharingId);

  /** The node's config page (`/nodes/$id`, spec §10). */
  function goDetail(id: string) {
    void navigate({ to: "/nodes/$id", params: { id } });
  }

  function goTab(next: NodesTab) {
    void navigate({ search: next === "list" ? {} : { tab: next } });
  }

  return (
    <DashboardPage>
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
            <Button disabled disabledReason={NODE_ENROLLMENT_OFF_COPY}>
              <Plus /> Add node
            </Button>
          )
        }
      />

      {/* `w-fit`: the fieldset is a block-level `flex`, so as a direct child of
        `<main>` it would stretch the tabs across the whole page width —
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
            maxLength={LIST_SEARCH_MAX.nodes}
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

          {(isLoading || results.isLoading) && <LoadingCard message="Loading nodes…" />}

          {/* A failed list load is not an empty account — say so, with a retry. */}
          {(isError || results.isError) && (
            <ErrorBanner
              message="Couldn't load nodes."
              className="rounded-md border"
              action={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-detail text-inherit underline"
                  onClick={() => void Promise.all([refetch(), results.refetch()])}
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

          {nodes.length > 0 && !results.isLoading && !results.isError && visible.length === 0 && (
            <EmptyState
              icon={Server}
              title="No nodes match"
              description="No node matches the current search and filters."
              actionLabel="Clear filters"
              onAction={() => setFilters(NODE_FILTERS_OFF)}
            />
          )}

          {visible.length > 0 && (
            <NodeTable
              nodes={visible}
              onOpenConfig={goDetail}
              onShare={setSharingId}
              onDelete={setDeletingNode}
              onError={setActionError}
            />
          )}
        </>
      )}

      {sharingNode && (
        <NodeSharingDialog
          key={sharingNode.id}
          nodeId={sharingNode.id}
          open
          canManage={sharingNode.canManage}
          onOpenChange={(open) => {
            if (!open) setSharingId(null);
          }}
        />
      )}
      {deletingNode && <DeleteNodeDialog node={deletingNode} onClose={() => setDeletingNode(null)} />}
      <AddNodeDialog open={dialogOpen} onOpenChange={setDialogOpen} nodeCount={nodes.length} />
    </DashboardPage>
  );
}
