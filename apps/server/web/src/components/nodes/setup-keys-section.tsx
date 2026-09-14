import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDeleteSetupKey, useSetupKeys } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";

/** Display state of a setup key: redeemed, expired unused, or still usable. */
function keyState(usedAt: string | null, expiresAt: string): "used" | "expired" | "unused" {
  if (usedAt) return "used";
  return Date.parse(expiresAt) < Date.now() ? "expired" : "unused";
}

/**
 * The caller's node setup keys (never the secret — it exists only in the
 * one-time reveal of the Add-node dialog). Exists so unused keys stay
 * REVOCABLE after the dialog closes: a minted-but-never-run command is an
 * open enrollment door for its 24 h.
 */
export function SetupKeysSection() {
  const { data, error, isLoading } = useSetupKeys();
  const remove = useDeleteSetupKey();
  const [rowError, setRowError] = useState<Record<string, string>>({});

  async function revoke(id: string, label: string) {
    setRowError((prev) => ({ ...prev, [id]: "" }));
    const ok = await confirmAction({ title: `Revoke setup key "${label}"?`, confirmLabel: "Revoke", danger: true });
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
        <CardDescription>Single-use enrollment credentials, valid 24 h. Revoke any you no longer need.</CardDescription>
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
                  <p className="truncate font-strong">{k.label}</p>
                  <p className="text-muted-foreground text-xs">
                    created {new Date(k.createdAt).toLocaleString()}
                    {k.consumedNodeId
                      ? ` · enrolled ${k.consumedNodeId}`
                      : ` · expires ${new Date(k.expiresAt).toLocaleString()}`}
                  </p>
                </div>
                <Badge variant={state === "unused" ? "success" : state === "expired" ? "warning" : "muted"}>
                  {state}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revoke(k.id, k.label)}
                  disabled={remove.isPending}
                >
                  Revoke
                </Button>
              </div>
              {rowError[k.id] && <p className="text-destructive text-xs">{rowError[k.id]}</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
