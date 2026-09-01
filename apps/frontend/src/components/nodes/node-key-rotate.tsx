import { KeyRound } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
import { useRotateNodeKey } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { RotatedNodeKey } from "@/types/node";

/**
 * Rotate-key affordance for one node (spec 2026-08-31 §9): a manager-only
 * POST mints a replacement key, disables the old one and drops the live
 * agent. The plaintext arrives in the response EXACTLY ONCE — this component
 * holds it in state only, renders the reveal card (the setup-key dialog's
 * `CopyCommandRow` pattern), and forgets it on Done or on any node switch.
 * The rotate deliberately asks first: it disconnects a working agent until
 * the operator re-configures it by hand.
 */
export function NodeKeyRotate({
  nodeId,
  nodeName,
  canManage,
}: {
  /** Node whose key is rotated */
  nodeId: string;
  /** Node display name — the confirm prompt and the reveal card */
  nodeName: string;
  /** Server-derived manager flag; others see the button disabled (the route 403s them anyway) */
  canManage: boolean;
}): JSX.Element {
  const rotate = useRotateNodeKey(nodeId);
  const [rotated, setRotated] = useState<RotatedNodeKey | null>(null);

  // Navigating to another node must retire the previous node's plaintext —
  // it is a secret, and the reveal card would otherwise ride along. The
  // `nodeId` dependency is load-bearing: TanStack reuses route components
  // across param changes (see the same hazard noted in routes/profiles_.$id),
  // so without it this effect runs once per mount and the old key survives
  // the switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire-on-change effect — nodeId is deliberately the trigger, not a read
  useEffect(() => {
    setRotated(null);
  }, [nodeId]);

  async function rotateKey() {
    const ok = await confirmAction({
      title: `Rotate the key for "${nodeName}"?`,
      description:
        "The current key stops working immediately and a connected agent is dropped. It reconnects only after the new key is put into its config by hand.",
      confirmLabel: "Rotate key",
      danger: true,
    });
    if (!ok) return;
    try {
      setRotated(await rotate.mutateAsync());
    } catch {
      // The mutation keeps the error; it renders beside the button.
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => void rotateKey()}
          disabled={!canManage || rotate.isPending}
          title={canManage ? undefined : "Only the node's manager can rotate its key"}
        >
          <KeyRound /> {rotate.isPending ? "Rotating…" : "Rotate key"}
        </Button>
        {rotate.isError && (
          <p role="alert" className="text-destructive text-sm">
            {errMessage(rotate.error, "Key rotation failed.")}
          </p>
        )}
      </div>
      {rotated && (
        <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm">New key for “{nodeName}” — shown once, only here. A lost key means rotating again.</p>
          <CopyCommandRow text={rotated.nodeKey} />
          <p className="text-muted-foreground text-xs">{rotated.message}</p>
          <Button variant="outline" size="sm" onClick={() => setRotated(null)}>
            Done — hide the key
          </Button>
        </div>
      )}
    </>
  );
}
