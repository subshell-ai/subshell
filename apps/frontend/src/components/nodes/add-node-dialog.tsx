import { useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
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
import { useCreateSetupKey } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import type { CreatedSetupKey } from "@/types/node";

/**
 * Two-step "Add node" flow (spec 2026-08-31 §5.1/§9): a label → a single-use
 * setup key whose plaintext is shown EXACTLY ONCE here, together with the
 * copy-ready install command to run on the new machine. While the dialog is
 * open the page polls the node list every 3 s, and the waiting hint flips to
 * "enrolled" when the machine shows up.
 */
export function AddNodeDialog({
  open,
  onOpenChange,
  nodeCount,
}: {
  /** Whether the dialog is shown (drives the parent's polling too) */
  open: boolean;
  /** Open/close from inside (Cancel/Done/overlay) */
  onOpenChange: (open: boolean) => void;
  /** Current visible-node count — its rise over the creation-time baseline means "enrolled" */
  nodeCount: number;
}) {
  const create = useCreateSetupKey();
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSetupKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [baselineCount, setBaselineCount] = useState<number | null>(null);

  function close() {
    onOpenChange(false);
    setCreated(null);
    setName("");
    setFormError(null);
    setCopied(false);
    setBaselineCount(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      setCreated(await create.mutateAsync(name.trim()));
      setBaselineCount(nodeCount);
      setName("");
    } catch (err) {
      setFormError(errMessage(err, "Something went wrong — no key was created."));
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      // Clipboard blocked (non-secure context) — the text stays selectable.
    }
  }

  const enrolled = created !== null && baselineCount !== null && nodeCount > baselineCount;
  // The same origin-swap the harness install help uses; the backend serves
  // /install.sh and accepts the key as ?setup_key= (downloads route).
  const installCommand = created
    ? `curl -fsSL "${window.location.origin}/install.sh?setup_key=${created.key}" | bash`
    : "";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Run this on the new machine</DialogTitle>
              <DialogDescription>
                The setup key below is shown once — copy the command now; a lost key means creating a new one.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{created.key}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyKey()}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <CopyCommandRow text={installCommand} />
            <p className="text-destructive text-xs">
              Single-use, expires in 24 h. This is the only time the full key is shown.
            </p>
            {enrolled ? (
              <p className="text-sm text-success">Node enrolled — close this dialog to see it in the list.</p>
            ) : (
              <p className="text-muted-foreground text-sm">Waiting for enrollment — run the command on that machine.</p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <DialogHeader>
              <DialogTitle>Add a node</DialogTitle>
              <DialogDescription>Name the machine — a single-use setup key is created for it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Label htmlFor="node-name">Node name</Label>
              <Input
                id="node-name"
                required
                maxLength={64}
                placeholder="e.g. mac mini"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {formError && <p className="text-destructive text-xs">{formError}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? "Creating…" : "Create setup key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
