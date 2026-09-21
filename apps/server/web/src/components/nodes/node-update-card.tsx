import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type NodeDetail,
} from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { useNodeUpdate } from "@/hooks/use-node-update";

/**
 * Update this machine's node binary from its own page (spec 2026-09-15 §5.3,
 * the route the Updates table rows already drive). The caller gates on
 * `managesNodeSections` (owner or edit on an agent node, the same rule as the
 * daemon sections and the route's own gate), so the card renders no permission
 * logic of its own.
 *
 * The button is deliberately NOT disabled while the node reads offline: a
 * HELD node (offline for every purpose but this command) is exactly the
 * machine this exists for, and a truly unreachable one gets the route's 409
 * explained in the alert line.
 */
export function NodeUpdateCard({ node }: { node: NodeDetail }): JSX.Element {
  const nodeUpdate = useNodeUpdate();
  const [accepted, setAccepted] = useState<{ to: string } | null>(null);
  const updating = nodeUpdate.pendingNodeId === node.id;

  // TanStack reuses route components across param changes, so navigating to
  // another node must retire this node's result line (same hazard as the
  // rotate card's plaintext).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire-on-change effect: node.id is deliberately the trigger, not a read
  useEffect(() => {
    setAccepted(null);
  }, [node.id]);

  async function start(): Promise<void> {
    setAccepted(null);
    nodeUpdate.reset();
    try {
      const res = await nodeUpdate.update(node.id);
      setAccepted({ to: res.to });
    } catch {
      // The hook keeps the failure and it renders below the button.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          Replace this machine's Subshell node with the newest release this server can offer. The agent restarts itself
          into the new binary when the install finishes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-detail text-muted-foreground">Running {node.agentVersion ?? "an unreported version"}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={updating} onClick={() => void start()}>
            {/* The POST blocks for the node's whole download-and-restart window,
                up to five minutes, so a bare disabled button reads as nothing
                happening. */}
            {updating && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
            {updating ? "Updating…" : "Update to latest"}
          </Button>
        </div>
        {accepted && (
          <p className="text-detail text-success">
            Update accepted. {node.name} is installing {accepted.to} and will reconnect by itself.
          </p>
        )}
        {nodeUpdate.failure?.nodeId === node.id && (
          <p role="alert" className="text-destructive text-detail">
            {nodeUpdate.failure.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
