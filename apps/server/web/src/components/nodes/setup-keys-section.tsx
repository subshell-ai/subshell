import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyableValue } from "@/components/ui/copyable-value";
import { useDeleteSetupKey, useSetupKeys } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";

/** Display state of a setup key: redeemed, expired unused, or still usable. */
function keyState(usedAt: string | null, expiresAt: string): "used" | "expired" | "unused" {
  if (usedAt) return "used";
  return Date.parse(expiresAt) < Date.now() ? "expired" : "unused";
}

/**
 * The caller's node setup keys, each with its OWN KEY TEXT, and revocable.
 *
 * Two things changed here on 2026-09-17. The row used to be titled by the label
 * the Add-node dialog asked for; that question is gone (a node names itself on the
 * machine that becomes it), and the label had one job left — naming a row whose key
 * you could not read — so the key is the title now. And reading it here is the POINT:
 * a minted key the dialog was closed on used to be an open enrollment door that could
 * only be CLOSED, never re-read, so the remedy was revoke and re-mint. That is why the
 * card also still carries what it always carried — `usedAt` and `expiresAt` decide
 * `keyState`, and a used or expired row's key is inert on sight.
 */
export function SetupKeysSection() {
  const { data, error, isLoading } = useSetupKeys();
  const remove = useDeleteSetupKey();
  const [rowError, setRowError] = useState<Record<string, string>>({});

  async function revoke(id: string, key: string) {
    setRowError((prev) => ({ ...prev, [id]: "" }));
    const ok = await confirmAction({ title: `Revoke setup key "${key}"?`, confirmLabel: "Revoke", danger: true });
    if (!ok) return;
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [id]: errMessage(err, "Could not revoke the key.") }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup keys</CardTitle>
        <CardDescription>
          Single-use enrollment credentials, valid 24 h. Each key stays listed here until it is used, expires, or is
          revoked — so the Add-node dialog is not the only place one can be read.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-destructive text-sm">Couldn't load setup keys.</p>}
        {!error && isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {!error && data?.keys.length === 0 && <p className="text-muted-foreground text-sm">No setup keys yet.</p>}
        {data?.keys.map((k) => {
          const state = keyState(k.usedAt, k.expiresAt);
          return (
            <div key={k.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  {/* The key is the row's identity now, so it gets the affordance a
                      person needs with it: shown in full, and one press to take it. */}
                  <p className="font-mono font-strong">
                    <CopyableValue value={k.key} label="Setup key" />
                  </p>
                  <p className="text-detail text-muted-foreground">
                    created {new Date(k.createdAt).toLocaleString()}
                    {k.consumedNodeId
                      ? ` · enrolled ${k.consumedNodeId}`
                      : ` · expires ${new Date(k.expiresAt).toLocaleString()}`}
                  </p>
                </div>
                <Badge variant={state === "unused" ? "success" : state === "expired" ? "warning" : "muted"}>
                  {state}
                </Badge>
                <Button variant="ghost" size="sm" onClick={() => void revoke(k.id, k.key)} disabled={remove.isPending}>
                  Revoke
                </Button>
              </div>
              {rowError[k.id] && <p className="text-destructive text-detail">{rowError[k.id]}</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
