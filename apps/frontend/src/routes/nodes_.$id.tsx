import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RefreshCw, Share2, Trash2 } from "lucide-react";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { NodeHarnessCard } from "@/components/nodes/node-harness-card";
import { osLabel } from "@/components/nodes/node-row";
import { NodeSharingDialog } from "@/components/nodes/node-sharing-dialog";
import { PageHeader } from "@/components/page-header";
import { relativeElapsed } from "@/components/session-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDeleteNode, useNode, useRecheckNode } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";

export const Route = createFileRoute("/nodes_/$id")({
  component: NodeDetailPage,
});

/**
 * One node's config page (spec 2026-08-31 §9/§10): machine facts, the
 * harness matrix with per-node toggles, the Re-check button, and the
 * Share/Delete actions.
 *
 * Gating is entirely server-derived: invisible nodes 404 (handled as a load
 * error, never a leak), `view` grantees get a fully read-only page (harness
 * switches and the Re-check button disabled, no Share/Delete —
 * `nodeCanConfigure` semantics), and Share/Delete enable on `Node.canManage`
 * (owner, or admin on `local` — the frontend must not re-derive admin
 * identity).
 */
function NodeDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const node = useNode(id);
  const recheck = useRecheckNode(id);
  const deleteNode = useDeleteNode();
  const [shareOpen, setShareOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function remove() {
    setActionError(null);
    const ok = await confirmAction({
      title: `Delete node "${node.data?.name ?? id}"?`,
      description: "Its enrollment key is revoked and profiles pinned to it are unpinned.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteNode.mutateAsync(id);
      void navigate({ to: "/nodes" });
    } catch (err) {
      setActionError(errMessage(err, "Failed to delete node"));
    }
  }

  if (node.isError) {
    // Absent and invisible collapse to one 404 server-side — say the same
    // thing here so the page never leaks which ids exist.
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <PageHeader title="Node" subtitle="Machine details" />
        <ErrorBanner
          message="Couldn't load this node — it may not exist, or it may be private to its owner."
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-inherit text-xs underline"
              onClick={() => void node.refetch()}
            >
              Retry
            </Button>
          }
        />
        <Link to="/nodes" className="text-muted-foreground text-sm underline">
          Back to nodes
        </Link>
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

  // Harness toggles follow the server's `nodeCanConfigure`: owner or `edit`
  // grantee (admins resolve to `edit`); a `view` grantee gets the read-only card.
  const canConfigure = n.access === "owner" || n.access === "edit";

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title={n.name}
        subtitle={n.kind === "local" ? "The control-plane host" : (n.hostname ?? "Enrolled agent")}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setShareOpen(true)}
              disabled={!n.canManage}
              title={n.canManage ? undefined : "Only the node's manager can change its sharing"}
            >
              <Share2 /> Share
            </Button>
            <Button
              variant="outline"
              onClick={() => void remove()}
              disabled={!n.canManage || n.kind === "local"}
              title={n.kind === "local" ? "The control-plane host cannot be deleted" : undefined}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        }
      />

      {actionError && (
        <p role="alert" className="text-destructive text-sm">
          {actionError}
        </p>
      )}

      <div className="rounded-lg border p-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="mt-1">
              <Badge variant={n.status === "online" ? "success" : "muted"}>{n.status}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last seen</dt>
            <dd>{n.lastSeenAt ? relativeElapsed(n.lastSeenAt) : "never"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">OS / arch</dt>
            <dd>
              {osLabel(n.os)}
              {n.arch ? ` · ${n.arch}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Hostname</dt>
            <dd className="truncate">{n.hostname ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Agent version</dt>
            <dd>{n.agentVersion ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Your access</dt>
            <dd>{n.access}</dd>
          </div>
          {n.capabilities.length > 0 && (
            <div className="col-span-full">
              <dt className="text-muted-foreground">Capabilities</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {n.capabilities.map((c) => (
                  <Badge key={c} variant="outline">
                    {c}
                  </Badge>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {n.kind === "agent" && (
        <div className="flex flex-wrap items-center gap-3">
          {/* The recheck route gates on `nodeCanConfigure` (owner|edit) — the
              same rule `canConfigure` mirrors above, so a `view` grantee gets
              the button disabled, matching the read-only harness toggles. */}
          <Button
            variant="outline"
            onClick={() => recheck.mutate()}
            disabled={!canConfigure || recheck.isPending}
            title={canConfigure ? undefined : "Only the node's owner or an edit grantee can re-check it"}
          >
            <RefreshCw /> {recheck.isPending ? "Re-checking…" : "Re-check"}
          </Button>
          {recheck.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errMessage(recheck.error, "Re-check failed — the node may be offline.")}
            </p>
          )}
          {recheck.isSuccess && <p className="text-success text-xs">Re-check sent — inventory will refresh shortly.</p>}
        </div>
      )}

      <NodeHarnessCard nodeId={n.id} canConfigure={canConfigure} />

      <p className="text-sm">
        <Link to="/nodes" className="text-muted-foreground underline">
          Back to nodes
        </Link>
      </p>

      <NodeSharingDialog nodeId={n.id} open={shareOpen} onOpenChange={setShareOpen} canManage={n.canManage} />
    </main>
  );
}
