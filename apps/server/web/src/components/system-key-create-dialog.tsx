import { Button, Input, Label } from "@internal/node-admin";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type CreatedSystemKey, keyErrorMessage, useCreateSystemKey } from "@/hooks/use-system-keys";

/**
 * The create flow for one system API key, opened from the page header's
 * `Create key` (it moved OUT of `SystemApiKeysCard` on 2026-09-25 so the page
 * carries its one create act in the top right, the shape Add node, Add user
 * and Add provider already set). The plaintext is shown exactly once, in the
 * reveal half of this dialog; the list only ever carries previews.
 */
export function SystemKeyCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateSystemKey();
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSystemKey | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    onOpenChange(false);
    setName("");
    setCreated(null);
    setCopied(false);
    setFormError(null);
  }

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

  async function copyKey() {
    if (!created) return;
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>Copy it now. This is the only time the full key is shown.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              {/* `min-w-0` is the fix, not decoration: a flex item's default
                  min-width is its content width, so the one-word key pushed
                  the dialog past itself and a scrollbar appeared at the
                  dialog's foot. `break-all` then wraps the secret where it
                  lives — a key shown once should be readable whole, not
                  scrolled. */}
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted p-3 font-mono text-sm">{created.key}</code>
              {/* The copy ICON, not the word (Patterns, `docs/design-system.md`) — and
                  the sentence above still says "Copy it now", so the verb is on the
                  screen even though the button no longer repeats it. */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={copied ? "API key copied" : "Copy API key"}
                onClick={() => void copyKey()}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-destructive text-detail">
              Store it somewhere safe. If it is lost, you will need to create a new key.
            </p>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
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
              <Button type="button" variant="ghost" onClick={close}>
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
  );
}
