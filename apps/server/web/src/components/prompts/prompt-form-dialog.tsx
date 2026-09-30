import { Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCreatePrompt, useUpdatePrompt } from "@/hooks/use-prompts";
import { fieldError, makeForm, useSubmitDisabled } from "@/lib/form";
import { type PromptDraft, promptDraftSchema } from "@/lib/prompt-form";
import { REQUIREMENT_GAP_CLASS } from "@/lib/requirement-tone";

/**
 * Add or edit a saved prompt (spec 2026-09-28): the description is required
 * because it is what every list and picker shows; the body is the prompt;
 * the switch is the everyone-or-none share. Mounted only while open (the
 * clone-dialog posture), so every open starts from a clean draft and a
 * cleared error. One dialog serves create and edit: `editingId` picks the
 * verb, `initial` seeds the fields. Since the gating sweep (spec 2026-09-29)
 * Save/Create is DISABLED until the one schema is satisfied — the guard in
 * onSubmit stays as the guarantee behind the explanation.
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
  const [serverError, setServerError] = useState<string | null>(null);
  const create = useCreatePrompt();
  const update = useUpdatePrompt();
  const busy = create.isPending || update.isPending;

  const form = makeForm({
    defaultValues: initial ?? { description: "", body: "", shared: false },
    validator: promptDraftSchema,
    onSubmit: async (draft) => {
      // The guard behind the gate (Enter-key paths, races).
      if (draft.description.trim() === "" || draft.body.trim() === "") return;
      setServerError(null);
      const trimmed = { ...draft, description: draft.description.trim() };
      try {
        if (editingId) await update.mutateAsync({ id: editingId, draft: trimmed });
        else await create.mutateAsync(trimmed);
        onOpenChange(false);
        onSaved?.();
      } catch (err) {
        // Render on the dialog that failed (the design-system rule): the
        // server's own sentence, not a re-worded one.
        setServerError(errMessage(err, "The prompt could not be saved"));
      }
    },
  });
  const disabled = useSubmitDisabled(form, busy);

  return (
    <Dialog open={open} onOpenChange={formDialogOpenChange(onOpenChange)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingId ? "Edit prompt" : "New prompt"}</DialogTitle>
          <DialogDescription>A saved prompt you can drop into any subshell.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <form.Field name="description">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="prompt-description">Description</Label>
                <Input
                  id="prompt-description"
                  value={field.state.value}
                  maxLength={120}
                  placeholder="Short label for discoverability"
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                  <p role="alert" className={REQUIREMENT_GAP_CLASS}>
                    {fieldError(field.state.meta.errors)}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          <form.Field name="body">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="prompt-body">Prompt</Label>
                <Textarea
                  id="prompt-body"
                  value={field.state.value}
                  rows={7}
                  placeholder="The text typed into the pane"
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                  <p role="alert" className={REQUIREMENT_GAP_CLASS}>
                    {fieldError(field.state.meta.errors)}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          <form.Field name="shared">
            {(field) => (
              <div className="flex items-center gap-4">
                <Switch
                  id="prompt-shared-switch"
                  checked={field.state.value}
                  onCheckedChange={(checked) => field.handleChange(checked === true)}
                />
                <div>
                  <Label htmlFor="prompt-shared-switch">Share with everyone</Label>
                  <p className="text-detail text-muted-foreground">Every account on this instance can read it.</p>
                </div>
              </div>
            )}
          </form.Field>
          {serverError && (
            <p role="alert" className="text-destructive text-detail">
              {serverError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={disabled}>
            {busy ? "Saving…" : editingId ? "Save" : "Create prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
