import { Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { PromptPickerBody } from "@/components/prompts/prompt-picker-body";
import { PromptStackList } from "@/components/prompts/prompt-stack-list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { RequiredMark } from "@/components/ui/required-mark";
import { useCreatePromptStack, useUpdatePromptStack } from "@/hooks/use-prompts";
import { fieldError, fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { movePromptBlock, newPromptLocalId, type PromptBlock, removePromptBlock } from "@/lib/prompt-stack";
import { makePromptStackSchema, stackMembersFromBlocks } from "@/lib/prompt-stack-form";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";

/**
 * Add or edit a prompt stack (spec 2026-09-29). The editor is the launch
 * form's "Add prompt" step, kept honest: the SAME `PromptStackList` rows
 * (up/down/remove) and the SAME inline picker body, with one difference
 * that is the rule - `allowStacks={false}`: a stack is a flat list of
 * prompts and free-text rows, never a stack of stacks. Saving sends the
 * full ordered member set (the server does a full replace).
 *
 * Mounted only while open (the prompt-dialog posture): every open starts
 * from a clean draft; a fresh CREATE needs at least one member, while an
 * EDIT may empty the stack (that save is the empty-stack lifecycle, not a
 * mistake). Save is DISABLED until the one schema is satisfied; the guard
 * behind it re-checks, the substrate's contract.
 */
export function StackFormDialog({
  open,
  onOpenChange,
  editingId,
  initial,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Set = PUT this row; absent = POST a new one */
  editingId?: string;
  /** Seed for edit; blank for a fresh create */
  initial?: { label: string; blocks: PromptBlock[]; shared: boolean };
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The member list's accessible name (round-8 nit): a bare Label is stray
  // text to a screen reader tabbing the rows; the list is labelled BY it.
  const membersLabelId = useId();
  const create = useCreatePromptStack();
  const update = useUpdatePromptStack();
  const busy = create.isPending || update.isPending;

  const form = makeForm({
    defaultValues: {
      label: initial?.label ?? "",
      blocks: initial?.blocks ?? [],
      shared: initial?.shared ?? false,
    },
    validator: makePromptStackSchema(editingId ? 0 : 1),
    onSubmit: async (values) => {
      // The guard behind the gate (Enter-key paths, races).
      if (values.label.trim() === "" || (!editingId && values.blocks.length === 0)) return;
      setServerError(null);
      const patch = {
        label: values.label.trim(),
        items: stackMembersFromBlocks(values.blocks),
        shared: values.shared,
      };
      try {
        if (editingId) await update.mutateAsync({ id: editingId, patch });
        else await create.mutateAsync(patch);
        onOpenChange(false);
      } catch (err) {
        // The server's own sentence, on the dialog that failed (the joined-
        // cap refusal lives here as much as in the client rule above).
        setServerError(errMessage(err, "The stack could not be saved"));
      }
    },
  });
  const disabled = useSubmitDisabled(form, busy);

  return (
    <Dialog open={open} onOpenChange={formDialogOpenChange(onOpenChange)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingId ? "Edit stack" : "New stack"}</DialogTitle>
          <DialogDescription>A stack is a set of prompts combined together.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <form.Field name="label">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="stack-label">
                  Label
                  <RequiredMark />
                </Label>
                <Input
                  id="stack-label"
                  value={field.state.value}
                  maxLength={120}
                  placeholder="Short name for the collection"
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                  <p role="alert" className={REQUIREMENT_CAPTION_CLASS}>
                    {fieldError(field.state.meta.errors)}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          <form.Field name="blocks">
            {(field) => (
              <div className="space-y-2">
                {/* Required on create (one member minimum); an edit may lawfully empty
                    the list, so no star there. */}
                <Label id={membersLabelId}>
                  Prompts
                  {editingId === undefined && <RequiredMark />}
                </Label>
                {field.state.value.length > 0 && (
                  <PromptStackList
                    labelledBy={membersLabelId}
                    blocks={field.state.value}
                    onReorder={(localId, dir) => field.handleChange(movePromptBlock(field.state.value, localId, dir))}
                    onRemove={(localId) => field.handleChange(removePromptBlock(field.state.value, localId))}
                  />
                )}
                {pickerOpen ? (
                  <div className="rounded-lg border p-3">
                    <PromptPickerBody
                      surface="inline"
                      mode="multi"
                      allowStacks={false}
                      draftScope="stack-editor"
                      onPick={(block) => {
                        field.handleChange([...field.state.value, { ...block, localId: newPromptLocalId() }]);
                        setPickerOpen(false);
                      }}
                      onExit={() => setPickerOpen(false)}
                    />
                  </div>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    <Plus /> Add prompt
                  </Button>
                )}
                {/* One slot, two facts: "needs at least one prompt" is a gap
                    (gold); the joined-cap sentence is a hard error (red). */}
                {field.state.meta.isTouched &&
                  (() => {
                    const shown = fieldErrorToned(field.state.meta.errors);
                    return (
                      shown && (
                        <p
                          role="alert"
                          className={shown.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail"}
                        >
                          {shown.text}
                        </p>
                      )
                    );
                  })()}
              </div>
            )}
          </form.Field>
          <form.Field name="shared">
            {(field) => (
              <div className="flex items-center gap-4">
                <Switch
                  id="stack-shared-switch"
                  checked={field.state.value}
                  onCheckedChange={(checked) => field.handleChange(checked === true)}
                />
                <div>
                  <Label htmlFor="stack-shared-switch">Share with everyone</Label>
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
            {busy ? "Saving…" : editingId ? "Save" : "Create stack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
