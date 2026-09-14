import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  type CreatedSystemKey,
  useCreateSystemKey,
  useDeleteSystemKey,
  useSetSystemKeyEnabled,
  useSystemKeys,
} from "@/hooks/use-system-keys";
import { ApiError } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";

/** Turns an apiFetch failure into short user-facing copy. */
function keyErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "Admin sign-in required to manage API keys.";
  return "Something went wrong. The change was not saved.";
}

/**
 * Admin management of system-wide API keys (the long-lived bearer
 * credentials for LAN tooling and scripts). The plaintext of a new key is
 * shown exactly once in the create flow; the list only ever carries previews.
 */
export function SystemApiKeysCard() {
  const { data, error, isLoading: keysLoading } = useSystemKeys();
  const create = useCreateSystemKey();
  const setEnabled = useSetSystemKeyEnabled();
  const remove = useDeleteSystemKey();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSystemKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      setCreated(await create.mutateAsync(name.trim()));
      setName("");
    } catch (err) {
      setFormError(keyErrorMessage(err));
    }
  }

  function closeDialog() {
    setDialogOpen(false);
    setCreated(null);
    setCopied(false);
    setFormError(null);
  }

  async function copyKey() {
    if (!created) return;
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
  }

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
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>System API keys</CardTitle>
            <CardDescription>Long-lived bearer keys for external tooling against this instance.</CardDescription>
          </div>
          <Button onClick={() => setDialogOpen(true)}>Create key</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-destructive text-sm">{keyErrorMessage(error)}</p>}
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

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent>
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>Key created</DialogTitle>
                <DialogDescription>Copy it now. This is the only time the full key is shown.</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{created.key}</code>
                <Button type="button" variant="outline" size="sm" onClick={() => void copyKey()}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-destructive text-detail">
                Store it somewhere safe. If it is lost, you will need to create a new key.
              </p>
              <DialogFooter>
                <Button onClick={closeDialog}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submitCreate}>
              <DialogHeader>
                <DialogTitle>New system key</DialogTitle>
                <DialogDescription>Give the key a name so you can recognise it later.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 py-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  required
                  maxLength={64}
                  placeholder="e.g. lan-backup"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                {formError && <p className="text-destructive text-detail">{formError}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button type="submit" disabled={create.isPending || !name.trim()}>
                  {create.isPending ? "Creating…" : "Create key"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
