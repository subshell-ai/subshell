import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  confirmAction,
  Switch,
} from "@internal/node-admin";
import { useState } from "react";
import { keyErrorMessage, useDeleteSystemKey, useSetSystemKeyEnabled, useSystemKeys } from "@/hooks/use-system-keys";

/**
 * The list half of system API key management (the long-lived bearer
 * credentials for LAN tooling and scripts): previews, the enabled switch, and
 * delete. Creating is NOT here since 2026-09-25 — the page header carries
 * `Create key` like every other admin page, and the flow lives in
 * `SystemKeyCreateDialog`; the list only ever carries previews.
 */
export function SystemApiKeysCard() {
  const { data, error, isLoading: keysLoading } = useSystemKeys();
  const setEnabled = useSetSystemKeyEnabled();
  const remove = useDeleteSystemKey();

  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function onDelete(id: string, keyName: string) {
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    const ok = await confirmAction({ title: `Delete key "${keyName}"?`, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [id]: keyErrorMessage(err) }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>System API keys</CardTitle>
        <CardDescription>API keys currently allow admin access to the Subshell Server API.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-destructive text-detail">{keyErrorMessage(error)}</p>}
        {!error && keysLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {!error && data?.keys.length === 0 && <p className="text-muted-foreground text-sm">No keys yet.</p>}
        {data?.keys.map((k) => (
          <div key={k.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="font-strong">{k.name}</p>
                <p className="font-mono text-detail text-muted-foreground">
                  {k.preview ?? "—"}
                  {k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : " · never expires"}
                </p>
              </div>
              <Badge variant={k.enabled ? "success" : "muted"}>{k.enabled ? "active" : "disabled"}</Badge>
              <Switch
                checked={k.enabled}
                onCheckedChange={(checked) =>
                  setEnabled.mutate(
                    { id: k.id, enabled: checked },
                    {
                      onError: (err) => setRowErrors((prev) => ({ ...prev, [k.id]: keyErrorMessage(err) })),
                    },
                  )
                }
                disabled={setEnabled.isPending}
                aria-label={`${k.name} enabled`}
              />
              <Button variant="ghost" size="sm" onClick={() => void onDelete(k.id, k.name)} disabled={remove.isPending}>
                Delete
              </Button>
            </div>
            {rowErrors[k.id] && <p className="text-destructive text-detail">{rowErrors[k.id]}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
