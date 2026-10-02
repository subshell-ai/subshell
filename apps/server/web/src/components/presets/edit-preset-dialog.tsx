import { apiFetch, Button, errMessage } from "@internal/node-admin";
import { useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { PresetFields } from "@/components/presets/preset-fields";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import { type FieldProblems, makeForm, useSubmitDisabled } from "@/lib/form";
import { crossCommSaveBlocked, presetFormFromRow, toPresetUpdatePayload } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/** Saves the stored preset, then reapplies its returned values to the launch. */
export function EditPresetDialog({
  preset,
  onClose,
  onSaved,
}: {
  preset: PresetRow;
  onClose: () => void;
  onSaved: (preset: PresetRow) => void;
}) {
  const cache = useQueryClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = useMutation({
    mutationFn: (draft: ReturnType<typeof presetFormFromRow>) =>
      apiFetch<PresetRow>(`/api/presets/${preset.id}`, {
        method: "PUT",
        body: JSON.stringify(toPresetUpdatePayload(draft)),
      }),
    onSuccess: (updated) => {
      cache.setQueryData<PresetRow[]>(PRESETS_QUERY_KEY, (rows) =>
        rows?.map((row) => (row.id === updated.id ? updated : row)),
      );
      void cache.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
      if (alive.current) {
        onSaved(updated);
        onClose();
      }
    },
  });
  const form = makeForm({
    defaultValues: { draft: presetFormFromRow(preset) },
    validator: ({ draft }): FieldProblems => {
      if (!draft.name.trim()) return { draft: "Enter a preset name." };
      if (crossCommSaveBlocked(draft))
        return { draft: "Cross-subshell communication needs a machine and working directory." };
      return {};
    },
    onSubmit: async ({ draft }) => {
      if (save.isPending || !draft.name.trim() || crossCommSaveBlocked(draft)) return;
      try {
        await save.mutateAsync(draft);
      } catch {
        /* Keep the editor open with the API error. */
      }
    },
  });
  const draft = useStore(form.store, (state) => state.values.draft);
  const disabled = useSubmitDisabled(form, save.isPending);
  return (
    <Dialog
      open
      onOpenChange={formDialogOpenChange((open) => {
        if (!open && !save.isPending) onClose();
      })}
    >
      <DialogContent className="sm:max-w-2xl" onClick={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Edit preset</DialogTitle>
          <DialogDescription>Saving updates this preset and applies it to your new subshell form.</DialogDescription>
        </DialogHeader>
        <PresetFields
          value={draft}
          onChange={(value) => form.setFieldValue("draft", value)}
          lockedHarness={preset.harnessId}
          defaultEntryMode="custom"
          draftScope={`launch-preset-${preset.id}`}
        />
        {save.error && (
          <p className="text-destructive text-detail">{errMessage(save.error, "Failed to save preset")}</p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={disabled} onClick={() => void form.handleSubmit()}>
            {save.isPending ? "Saving…" : "Save and apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
