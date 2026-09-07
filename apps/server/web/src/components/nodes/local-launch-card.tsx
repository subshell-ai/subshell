import { Link } from "@tanstack/react-router";
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
 * Settings-page switch for local launching (spec 2026-08-31 §10). There is no
 * dedicated endpoint: ON is the seeded Everyone/`edit` grant on `local`, OFF
 * is its removal. The shares PUT replaces the WHOLE grant set, so the card
 * read-modifies-writes: it keeps every per-user grant from the node's
 * embedded `shares` and only ever adds/drops the Everyone row(s). The source
 * is the node detail, not the manager-only shares GET — a manager is always
 * config-capable, so `shares` rides the same fetch the card already makes.
 * While that set is unknown (the detail has not answered yet) the switch
 * stays disabled: a `[]`-fallback draft would full-replace and erase every
 * live grant.
 *
 * Visibility is `Node.canManage` on `local` — the server's own answer (real
 * owner, or admin), never a client-side admin re-derivation. A viewer who
 * cannot manage it, or cannot even see `local` (404), renders nothing here.
 */
export function LocalLaunchCard() {
  const { data: node } = useNode("local");
  const setShares = useSetNodeShares("local");
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
        <CardTitle>Launch on this host</CardTitle>
        <CardDescription>
          Allow launching subshells on this control-plane host. Turning it off makes the host unselectable in the
          new-subshell node picker — subshells cannot start anywhere until another node is shared for launching. This
          only removes or reinstalls the Everyone grant; custom per-user shares on this host are kept.
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
          <Label>{on ? "Everyone can launch here" : "Local launching is off"}</Label>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <p className="text-sm">
          <Link to="/nodes/$id" params={{ id: "local" }} className="underline">
            Node settings
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
