import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  nodeHarnessErrorMessage,
  useHarnesses,
  useNodeHarnesses,
  useSetNodeHarnessEnabled,
} from "@/hooks/use-harnesses";
import { checkedAtLabel } from "@/lib/checked-at";

/**
 * The harness matrix of one node (spec 2026-08-31 §6.2/§9): every registered
 * plugin × this node's installed/enabled state, with the enable/disable
 * switch only for config-capable viewers (`nodeCanConfigure` parity — owner,
 * `edit` grantee or admin; `view` grantees get the same card read-only).
 * Enabling on an agent whose fresh inventory reports the binary absent 409s —
 * the server's own message is shown inline on that row. The rows ride the node
 * detail query (no second fetch), so the Re-check button on the page is what
 * refreshes them for agents.
 */
export function NodeHarnessCard({ nodeId, canConfigure }: { nodeId: string; canConfigure: boolean }) {
  const { harnesses, data, isLoading } = useNodeHarnesses(nodeId);
  // Registry only for display names; absent entries fall back to the raw id
  // (a plugin can exist on a node before this browser's registry lists it).
  const { data: registry } = useHarnesses();
  const setEnabled = useSetNodeHarnessEnabled(nodeId);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function toggle(harnessId: string, enabled: boolean) {
    setErrors((prev) => ({ ...prev, [harnessId]: "" }));
    setEnabled.mutate(
      { harnessId, enabled },
      { onError: (err) => setErrors((prev) => ({ ...prev, [harnessId]: nodeHarnessErrorMessage(err) })) },
    );
  }

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Harnesses</CardTitle>
        <CardDescription>
          Agent CLIs on this node and whether subshells may use them here. Enabling an agent harness that its inventory
          reports as not installed is refused.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.inventoryStale && (
          <p className="text-muted-foreground text-sm">
            The inventory may be outdated — installed states are last-known, not live. Run a re-check to refresh.
          </p>
        )}
        {harnesses.map((h) => {
          const name = registry?.find((r) => r.id === h.harnessId)?.name ?? h.harnessId;
          return (
            <div key={h.harnessId} className="space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                <Badge variant={h.installed ? "success" : "muted"}>{h.installed ? "installed" : "not installed"}</Badge>
                {h.version && <span className="font-mono text-muted-foreground text-xs">{h.version}</span>}
                {checkedAtLabel(h.checkedAt) && (
                  <span className="text-muted-foreground text-xs">{checkedAtLabel(h.checkedAt)}</span>
                )}
                <Switch
                  checked={h.enabled}
                  disabled={!canConfigure || setEnabled.isPending}
                  onCheckedChange={(checked) => toggle(h.harnessId, checked)}
                  aria-label={`${name} enabled on this node`}
                />
              </div>
              {h.reason === "override-invalid" && (
                <p className="text-muted-foreground text-xs">
                  An environment variable overrides where this binary is looked for, and it doesn't point at an
                  executable file on this node.
                </p>
              )}
              {errors[h.harnessId] && (
                <p role="alert" className="text-destructive text-xs">
                  {errors[h.harnessId]}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
