import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSetNodeShares } from "@/hooks/use-node-shares";
import { useNode } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";

/**
 * Settings-page switch for local launching (spec 2026-08-31 §10). There is no
 * dedicated endpoint: ON is the seeded Everyone/`edit` grant on `local`, OFF
 * is its removal, so the card is a pinned single-row editor over the node
 * shares PUT — saving replaces the whole grant set on the host (copy says so;
 * the UI only ever moves the Everyone/edit row, the API stays the superset).
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
  const on = (node.shares ?? []).some((s) => s.granteeUserId === null && s.permission === "edit");

  function toggle(checked: boolean) {
    setError(null);
    setShares.mutate(checked ? [{ granteeUserId: null, permission: "edit" }] : [], {
      onError: (err) => setError(errMessage(err, "Couldn't change the local-launch setting.")),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Launch on this host</CardTitle>
        <CardDescription>
          Allow launching sessions on this control-plane host. Turning it off makes the host unselectable in the
          new-session node picker — sessions cannot start anywhere until another node is shared for launching. Saving
          replaces ALL grants on this host, so any custom per-user shares are removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          <Switch
            checked={on}
            onCheckedChange={toggle}
            disabled={setShares.isPending}
            aria-label="Allow launching sessions on this control-plane host"
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
