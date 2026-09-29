import { Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCreatePrompt, useUpdatePrompt } from "@/hooks/use-prompts";
import { type PromptDraft, validatePromptDraft } from "@/lib/prompt-form";

/**
 * Add or edit a saved prompt (spec 2026-09-28): the description is required
 * because it is what every list and picker shows; the body is the prompt;
 * the switch is the everyone-or-none share. Mounted only while open (the
 * clone-dialog posture), so every open starts from a clean draft and a
 * cleared error. One dialog serves create and edit: `editingId` picks the
 * verb, `initial` seeds the fields.
 */
export function PromptFormDialog({
  open,
  onOpenChange,
  editingId,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Set = PUT this row; absent = POST a new one */
  editingId?: string;
  /** Seed for edit/clone; blank for a fresh create */
  initial?: PromptDraft;
  onSaved?: () => void;
}) {
  const [draft, setDraft] = useState<PromptDraft>(initial ?? { description: "", body: "", shared: false });
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePrompt();
  const update = useUpdatePrompt();
  const busy = create.isPending || update.isPending;

  async function submit() {
    const invalid = validatePromptDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    const trimmed = { ...draft, description: draft.description.trim() };
    try {
      if (editingId) await update.mutateAsync({ id: editingId, draft: trimmed });
      else await create.mutateAsync(trimmed);
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      // Render on the dialog that failed (the design-system rule): the
      // server's own sentence, not a re-worded one.
      setError(errMessage(err, "The prompt could not be saved"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingId ? "Edit prompt" : "New prompt"}</DialogTitle>
          <DialogDescription>A saved prompt you can drop into any subshell.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="prompt-description">Description</Label>
            <Input
              id="prompt-description"
              value={draft.description}
              maxLength={120}
              placeholder="Short label for the list"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prompt-body">Prompt</Label>
            <Textarea
              id="prompt-body"
              value={draft.body}
              rows={7}
              placeholder="The text typed into the pane"
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-4">
            <Switch
              checked={draft.shared}
              onCheckedChange={(checked) => setDraft({ ...draft, shared: checked === true })}
              aria-label="Share with everyone"
            />
            <div>
              <Label>Share with everyone</Label>
              <p className="text-detail text-muted-foreground">Every account on this instance can read it.</p>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-detail">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : editingId ? "Save" : "Create prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
