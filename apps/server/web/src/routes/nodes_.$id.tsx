import {
  Badge,
  Button,
  confirmAction,
  errMessage,
  NodeMaintenanceCard,
  relativeElapsed,
  useNode,
} from "@internal/node-admin";
import {
  MIN_NODE_VERSION,
  NODE_NAME_MAX,
  NODE_NAME_MAX_UNITS,
  NODE_PROTOCOL_VERSION,
  nodeVersionSupported,
} from "@internal/subshell-protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Share2, Trash2 } from "lucide-react";
import { useState } from "react";
import { EditableText } from "@/components/editable-text";
import { NodeHarnessCard } from "@/components/nodes/node-harness-card";
import { NodeKeyRotate } from "@/components/nodes/node-key-rotate";
import { NodePageShell } from "@/components/nodes/node-page-shell";
import { osLabel } from "@/components/nodes/node-row";
import { NodeSharingDialog } from "@/components/nodes/node-sharing-dialog";
import { useDeleteNode, useRenameNode } from "@/hooks/use-nodes";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

export const Route = createFileRoute("/nodes_/$id")({
  component: NodeDetailPage,
});

/**
 * One node's config page (spec 2026-08-31 §9/§10): machine facts, the
 * node's harness detection card, the Rotate-key action, and the Share/Delete
 * actions. The title renames itself (owner-only PATCH; `local`'s name is
 * fixed for everyone).
 *
 * The harness card is read-only everywhere (spec 2026-09-10: plugins are
 * instance-level and managed under `/settings/plugins`); its one control,
 * Re-check, moved inside the card and gates itself on the view's server-
 * derived `access` (owner|edit — the rule the recheck route applies), not on
 * `canManage`.
 *
 * Gating is entirely server-derived: invisible nodes 404 (handled as a load
 * error, never a leak), and Share/Delete enable on `Node.canManage` (owner,
 * or admin on `local` — the frontend must not re-derive admin identity).
 */
function NodeDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const node = useNode(id);
  const renameNode = useRenameNode(id);
  const deleteNode = useDeleteNode();
  const [shareOpen, setShareOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /** Owner-only rename; a 409 NODE_NAME_TAKEN (or the `local` 400) surfaces inline in the field. */
  async function saveName(name: string): Promise<void> {
    await renameNode.mutateAsync(name);
  }

  async function remove() {
    setActionError(null);
    const ok = await confirmAction({
      title: `Delete node "${node.data?.name ?? id}"?`,
      description: "Its enrollment key is revoked.",
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

  return (
    <NodePageShell
      id={id}
      title={
        // Rename is owner-gated: `canManage` is exactly that gate — a real
        // owner on an agent node, or an admin on `local`, whose boost is
        // `local`-only. So an admin names the control-plane host's row and
        // nobody else's (spec §9 stands for agents).
        node.data?.canManage ? (
          <EditableText
            value={node.data.name}
            placeholder={node.data.id}
            label="Rename node"
            onSave={saveName}
            maxLength={NODE_NAME_MAX_UNITS}
            maxChars={NODE_NAME_MAX}
          />
        ) : undefined
      }
      action={(n) => (
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
      )}
    >
      {(n) => (
        <>
          {actionError && (
            <p role="alert" className="text-destructive text-sm">
              {actionError}
            </p>
          )}

          <div className="rounded-lg border p-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge variant={n.status === "online" ? "success" : "muted"}>{n.status}</Badge>
                  {/* Any mismatch, either direction: the protocol is matched
                      EXACTLY, so a node ahead of the server is refused just as
                      a node behind it is. Naming which way round it is turns a
                      bare "offline" into an actionable message. */}
                  {n.status === "offline" &&
                    n.protocolVersion != null &&
                    n.protocolVersion !== NODE_PROTOCOL_VERSION && (
                      <Badge
                        variant="warning"
                        title={`This node speaks protocol v${n.protocolVersion}; this control plane speaks v${NODE_PROTOCOL_VERSION}. Update the ${
                          n.protocolVersion < NODE_PROTOCOL_VERSION ? "node" : "server"
                        } to match.`}
                      >
                        {n.protocolVersion < NODE_PROTOCOL_VERSION ? "node too old" : "node too new"}
                      </Badge>
                    )}
                </dd>
              </div>
              {/* Node facts, and `local` runs no node daemon — it is a launch
                  target the server drives in-process through `LocalLauncher`,
                  with no daemon, no socket and no enrollment. So `lastSeenAt`
                  is stamped by a connection that never happens and
                  `agentVersion` by a `ready` frame nobody sends: the two
                  rendered a permanent "never" and "—" that read as a broken
                  node rather than as questions this row cannot be asked. Same
                  reason `local` is excluded from the version-floor list. */}
              {n.kind !== "local" && (
                <div>
                  <dt className="text-muted-foreground">Last seen</dt>
                  <dd>{n.lastSeenAt ? relativeElapsed(n.lastSeenAt) : "never"}</dd>
                </div>
              )}
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
              {n.kind !== "local" && (
                <div>
                  <dt className="text-muted-foreground">Node version</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-2">
                    {n.agentVersion ?? "—"}
                    {/* The OTHER refusal gate, and an independent one: the floor
                      is raised whenever the server needs newer node behaviour,
                      with or without a protocol bump. Not gated on `offline`,
                      because the floor is checked at connect and such a node
                      never gets online. */}
                    {n.agentVersion != null && !nodeVersionSupported(n.agentVersion) && (
                      <Badge
                        variant="warning"
                        title={`This control plane requires subshell ${MIN_NODE_VERSION} or newer; this node reports ${n.agentVersion}. Update the node on that host.`}
                      >
                        below minimum ({MIN_NODE_VERSION})
                      </Badge>
                    )}
                  </dd>
                </div>
              )}
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

          {/* Whether this machine takes new work at all (spec 2026-09-14).
              Every kind, and on the OVERVIEW: `local` has no Configuration
              section — its own config surface is Server Settings — and a
              switch that moves between sections depending on the kind of
              machine is one people stop finding. */}
          {/* The flip's fallout on THIS surface: every subshell of the viewer's
              that ran here went `terminated` the instant the PUT answered, and
              nothing else on the page refetches the sidebar list. */}
          <NodeMaintenanceCard
            node={n}
            onMaintenanceChanged={() => void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY })}
          />

          {/* Key rotation lives with the enrolled nodes: `local`'s key is the
              control plane's own credential — mint/rotate it server-side
              deliberately, not from a button on its own status page. */}
          {n.kind === "agent" && <NodeKeyRotate nodeId={n.id} nodeName={n.name} canManage={n.canManage} />}

          <NodeHarnessCard nodeId={n.id} />

          <NodeSharingDialog nodeId={n.id} open={shareOpen} onOpenChange={setShareOpen} canManage={n.canManage} />
        </>
      )}
    </NodePageShell>
  );
}
