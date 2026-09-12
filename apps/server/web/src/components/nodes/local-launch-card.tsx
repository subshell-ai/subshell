import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSetNodeShares } from "@/hooks/use-node-shares";
import { useNode } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import type { NodeShare } from "@/types/node";

/** One row of the shares PUT body (the mutation's write shape, no id/name). */
type ShareWrite = Pick<NodeShare, "granteeUserId" | "permission">;

/**
 * The local-launch switch (spec 2026-08-31 §10), rendered on the `local`
 * node's own detail page — it and the allowed-directories card are both "who
 * may launch here, and where" (spec 2026-09-11 §4.6 moved it off `/settings`).
 * There is no dedicated endpoint: ON is the seeded Everyone/`edit` grant on
 * `local`, OFF is its removal. The shares PUT replaces the WHOLE grant set,
 * so the card read-modifies-writes: it keeps every per-user grant from the node's
 * embedded `shares` and only ever adds/drops the Everyone row(s). The source
 * is the node detail, not the manager-only shares GET — a manager is always
 * config-capable, so `shares` rides the same fetch the card already makes.
 * While that set is unknown (the detail has not answered yet) the switch
 * stays disabled: a `[]`-fallback draft would full-replace and erase every
 * live grant.
 *
 * Visibility is `Node.canManage` — the server's own answer (real owner, or
 * admin), never a client-side admin re-derivation. A viewer who cannot manage
 * the node, or cannot even see it (404), renders nothing here.
 *
 * The node id is a PROP rather than a hardcoded `"local"`, so the page's
 * `kind === "local"` gate and this card's target are one decision instead of
 * two that happen to agree.
 */
export function LocalLaunchCard({ nodeId }: { nodeId: string }) {
  const { data: node } = useNode(nodeId);
  const setShares = useSetNodeShares(nodeId);
  const [error, setError] = useState<string | null>(null);

  if (!node?.canManage) return null;
  const existing = node.shares;
  const on = (existing ?? []).some((s) => s.granteeUserId === null && s.permission === "edit");

  function toggle(checked: boolean) {
    // The handler owns the same guard the `disabled` prop draws: no grant set
    // yet, or a write in flight → a draft built here would full-replace onto
    // stale truth (belt beyond Base UI's internal disabled guard).
    if (existing === undefined || setShares.isPending) return;
    setError(null);
    // Only the Everyone row(s) move; per-user grants survive both directions.
    //
    // The filter is by GRANTEE, not by grantee-and-`edit`, and that is
    // required rather than sloppy: on a node, ANY share lets the grantee
    // launch there — `view` included (docs/security.md, Nodes). So an
    // Everyone/`view` row left behind by an "off" would leave every user
    // still able to launch here, which is the one thing this switch promises
    // to stop. Off therefore clears every Everyone row, and on reinstates
    // exactly one at `edit`.
    const perUser: ShareWrite[] = (existing ?? [])
      .filter((s) => s.granteeUserId !== null)
      .map((s) => ({ granteeUserId: s.granteeUserId, permission: s.permission }));
    const next: ShareWrite[] = checked ? [...perUser, { granteeUserId: null, permission: "edit" }] : perUser;
    setShares.mutate(next, {
      onError: (err) => setError(errMessage(err, "Couldn't change the local-launch setting.")),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Launch on the server</CardTitle>
        <CardDescription>
          Allow launching subshells on this control-plane host. Turning it off makes the host unselectable in the
          new-subshell node picker. Subshells cannot start anywhere until another node is shared for launching. This
          only removes or reinstalls the Everyone grants; custom per-user shares on it are kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          <Switch
            checked={on}
            onCheckedChange={toggle}
            // No grant set yet → no draft to modify; enabling here would PUT
            // a []-built set and wipe every live grant.
            disabled={setShares.isPending || existing === undefined}
            aria-label="Allow launching subshells on this control-plane host"
          />
          <Label>{on ? "Everyone can launch here" : "Launching on the server is off"}</Label>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
