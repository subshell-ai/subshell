import { Button, errMessage } from "@internal/node-admin";
import { type JSX, useState } from "react";
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
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useCreatePreset } from "@/hooks/use-presets";
import { crossCommSaveBlocked, emptyPresetForm, type PresetFormValue, toPresetPayload } from "@/lib/preset-form";

/**
 * The preset-create dialog, in two postures (spec 2026-09-13 §5, review
 * round 3): UNLOCKED on `/presets` (the Agent select is part of the form),
 * and CLONED, where `initialForm` seeds the values carried over from an
 * existing preset. The header reads "Clone preset", but the POST is still a
 * plain create, and the harness LOCKS ITSELF off the seed: a preset's
 * harness is immutable, so a clone always stays with its agent.
 *
 * It used to carry a third posture, LOCKED-BY-PROPS, for the launch form's
 * nested `+` (ruling 2026-09-30 replaced that door with the form's "Save as
 * preset" checkbox); the prop and the `onCreated` handoff left with their
 * only caller. The launch form now creates its preset through
 * `useCreateSubshell` directly.
 *
 * The mount IS the open (clone-dialog posture): every open starts from a
 * blank form and a cleared error for free, and in the clone posture from a
 * fresh seed of the then-current source, so a second Clone starts from the
 * preset as it is now, not as it was when the first dialog mounted.
 * A successful create invalidates the preset list (in `useCreatePreset`).
 */
export function CreatePresetDialog({
  open,
  onOpenChange,
  initialForm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The clone posture, on its own: form values carried over from an
   * existing preset (name/env/flags/restart), which also LOCK the harness —
   * a preset's harness is immutable, so the clone's agent is the source's,
   * read off the seed rather than passed alongside it. The POST is still a
   * plain create. */
  initialForm?: PresetFormValue;
}): JSX.Element {
  // The lock is DERIVED from the seed: a caller cannot seed a clone and
  // forget to lock it (a stored row's harnessId is never "").
  const lock = initialForm?.harnessId;
  const [form, setForm] = useState<PresetFormValue>(() => initialForm ?? emptyPresetForm());
  const create = useCreatePreset();
  // Only for the locked title's agent NAME — the catalog is already cached by
  // whoever raised this dialog, so this reads, it does not fetch twice.
  const { data: pluginData } = useInstancePlugins();
  const lockedName = lock !== undefined ? ((pluginData?.plugins ?? []).find((p) => p.id === lock)?.name ?? lock) : "";
  const chosenName =
    form.harnessId !== ""
      ? ((pluginData?.plugins ?? []).find((p) => p.id === form.harnessId)?.name ?? form.harnessId)
      : null;

  async function submit() {
    try {
      await create.mutateAsync(toPresetPayload(form));
      onOpenChange(false);
    } catch {
      // Stay open: the mutation's error renders beside the button that can
      // press it again.
    }
  }

  return (
    <Dialog open={open} onOpenChange={formDialogOpenChange(onOpenChange)}>
      <DialogContent className="sm:max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{initialForm !== undefined ? "Clone preset" : "Create preset"}</DialogTitle>
          <DialogDescription>
            Saved flags, env vars and restart policy.
            {lock !== undefined
              ? ` Every subshell you start with it launches ${lockedName} this way.`
              : chosenName !== null
                ? ` Every subshell you start with it launches ${chosenName} this way.`
                : ""}
          </DialogDescription>
        </DialogHeader>
        <PresetFields value={form} onChange={setForm} lockedHarness={lock} />
        {create.error && <p className="text-destructive text-detail">{errMessage(create.error, "Failed")}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || !form.harnessId || form.name.trim() === "" || crossCommSaveBlocked(form)}
          >
            {create.isPending ? "Creating…" : "Create preset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
