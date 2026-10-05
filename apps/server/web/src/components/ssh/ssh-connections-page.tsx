import { Button } from "@internal/node-admin";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { SshConnectionCard } from "@/components/ssh/ssh-connection-card";
import { SshConnectionEditor } from "@/components/ssh/ssh-connection-editor";
import { useNodes } from "@/hooks/use-nodes";
import { useSshConnections } from "@/hooks/use-ssh";
import type { SshConnectionView } from "@/lib/ssh";
import { FALLBACK_NODE_ID, nodeLabelFor } from "@/lib/subshell-node-groups";

/**
 * The SSH connections settings page (spec §3's Connection UI). The list is
 * per-CALLER: `GET /api/ssh/connections` answers the owner's rows, so a
 * member and an admin see their own private sets and nothing else's (spec §2:
 * connections are private in v1 and admin status does not widen them).
 *
 * Loading, empty, and failed are three answers, not two - the three-way
 * distinction the audit trail page established: a broken read must never
 * render as "nothing saved yet".
 */
export function SshConnectionsPage() {
  const { data, isError } = useSshConnections();
  const { data: nodesData } = useNodes();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SshConnectionView | null>(null);

  const connections = data?.connections;

  // The route line names the MACHINE the ssh runs from; the label ladder is
  // the rail's (resolved name, short id only while the nodes read has never
  // answered, "unknown node" once it answered without the id).
  const labelFor = useMemo(() => {
    const unanswered = nodesData === undefined;
    const nodes = nodesData?.nodes;
    return (nodeId: string) => {
      const id = nodeId || FALLBACK_NODE_ID;
      return nodeLabelFor(id, nodes, unanswered).label;
    };
  }, [nodesData]);

  function openCreate(): void {
    setEditing(null);
    setEditorOpen(true);
  }
  function openEdit(conn: SshConnectionView): void {
    setEditing(conn);
    setEditorOpen(true);
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title="SSH connections"
        action={
          <Button onClick={openCreate}>
            <Plus /> New connection
          </Button>
        }
      />
      <p className="text-detail text-muted-foreground">
        Saved destinations agents can reach through an enrolled node. Credentials and host trust stay on the connecting
        machine.
      </p>

      {connections === undefined ? (
        isError ? (
          <p role="alert" className="text-destructive text-detail">
            Couldn't load your SSH connections.
          </p>
        ) : (
          <p className="text-detail text-muted-foreground">Loading…</p>
        )
      ) : connections.length === 0 ? (
        <p className="text-detail text-muted-foreground">
          No SSH connections yet. A connection is saved on this account alone.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((conn) => (
            <SshConnectionCard
              key={conn.id}
              conn={conn}
              nodeLabel={labelFor(conn.nodeId)}
              onEdit={() => openEdit(conn)}
            />
          ))}
        </div>
      )}

      <SshConnectionEditor open={editorOpen} onOpenChange={setEditorOpen} connection={editing} />
    </main>
  );
}
