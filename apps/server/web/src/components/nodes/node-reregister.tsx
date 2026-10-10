import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type CreatedSetupKey,
  confirmAction,
  errMessage,
} from "@internal/node-admin";
import { useEffect, useRef, useState } from "react";
import { NodeKeySetup } from "@/components/nodes/node-key-setup";
import { useReregisterNode } from "@/hooks/use-nodes";

/**
 * Recovery uses the ordinary client enrollment form with a node-bound key.
 *
 * Gated on the RETIRE answer (`canRetire`: owner or any admin, ruling
 * 2026-10-09), which is exactly the reregister route's own gate. Not
 * `canManage`: sharing someone else's machine is still their owner's act, but
 * replacing its credentials is the operator's too.
 */
export function NodeReregister({
  nodeId,
  nodeName,
  canRetire,
}: {
  nodeId: string;
  nodeName: string;
  canRetire: boolean;
}) {
  const mint = useReregisterNode(nodeId);
  const generation = useRef(0);
  const [created, setCreated] = useState<{ nodeId: string; key: CreatedSetupKey } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing nodes retires the recovery key and errors
  useEffect(() => {
    generation.current += 1;
    setCreated(null);
    mint.reset();
    return () => {
      generation.current += 1;
    };
  }, [nodeId, mint.reset]);
  const pending = mint.isPending && mint.variables === nodeId;
  const failed = mint.isError && mint.variables === nodeId;
  const key = created?.nodeId === nodeId ? created.key : null;

  async function generate() {
    const attempt = generation.current;
    if (
      !(await confirmAction({
        title: `Re-register ${nodeName}?`,
        description:
          "Create a setup key for this node. Using it replaces this node's credentials and disconnects its current connection. Its entry, name, shares, and settings are kept.",
        confirmLabel: "Generate setup key",
      }))
    )
      return;
    if (generation.current !== attempt) return;
    try {
      const key = await mint.mutateAsync(nodeId);
      if (generation.current === attempt) setCreated({ nodeId, key });
    } catch {
      /* mutation renders the error */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Re-register Node</CardTitle>
        <CardDescription>
          Register this machine again with Subshell Client while keeping its existing node entry.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {key ? (
          <>
            <p className="text-detail text-muted-foreground">
              This setup key is tied to {nodeName}, is single-use, and expires after 24 hours. In Subshell Client, open
              Service → Re-enroll and use this key and the server address below. The existing connection keeps working
              until the key is used.
            </p>
            <NodeKeySetup keyText={key.key} defaultMethod="desktop" />
            <Button variant="outline" size="sm" onClick={() => setCreated(null)}>
              Done, hide the key
            </Button>
          </>
        ) : (
          <Button
            onClick={() => void generate()}
            disabled={!canRetire || pending}
            title={canRetire ? undefined : "Only the node's owner or an admin can re-register it"}
          >
            {pending ? "Generating…" : "Re-register"}
          </Button>
        )}
        {failed && (
          <p className="text-destructive text-detail">
            {errMessage(mint.error, "Could not create a re-registration key.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
