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
} from "@/components/ui/dialog";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useCreatePreset } from "@/hooks/use-presets";
import { emptyPresetForm, type PresetFormValue, toPresetPayload } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/**
 * The "New preset" dialog, in two postures (spec 2026-09-13 §5): UNLOCKED on
 * `/presets` (the Agent select is part of the form), and LOCKED inside the
 * launch dialog, where the Agent was just chosen and only its presets make
 * sense — the agent renders as static text and rides the POST.
 *
 * A third posture: with `initialForm` the form starts from a seed carried
 * over from an existing preset — a CLONE. The header reads "Clone preset",
 * but the POST is still a plain create, and the harness LOCKS ITSELF off the
 * seed: a preset's harness is immutable, so a clone always stays with its
 * agent. `initialForm` alone fully specifies this posture — a caller cannot
 * seed a clone and forget to lock it, because the lock is derived, not paired.
 *
 * Base UI nests dialogs natively, so mounting this inside the launch dialog
 * works: Escape closes this one first. The mount IS the open (clone-dialog
 * posture): every open starts from a blank form and a cleared error for free,
 * and in the clone posture from a fresh seed of the then-current source, so a
 * second Clone starts from the preset as it is now, not as it was when the
 * first dialog mounted.
 * A successful create invalidates the preset list (in `useCreatePreset`) and
 * hands the row to `onCreated` — the launch form selects it.
 */
export function CreatePresetDialog({
  open,
  onOpenChange,
  lockedHarness,
  initialForm,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent id to lock the form to WITHOUT seeding a clone — the launch
   * form's nested posture. The clone posture needs neither prop here:
   * `initialForm` locks itself. */
  lockedHarness?: string;
  /** The clone posture, on its own: form values carried over from an
   * existing preset (name/env/flags/restart), which also LOCK the harness —
   * a preset's harness is immutable, so the clone's agent is the source's,
   * read off the seed rather than passed alongside it. The POST is still a
   * plain create. */
  initialForm?: PresetFormValue;
  /** Called with the created row (after the list invalidation) */
  onCreated?: (row: PresetRow) => void;
}): JSX.Element {
  // The lock is DERIVED, not paired with the seed: the clone posture is fully
  // specified by `initialForm` alone (a stored row's harnessId is never "").
  const lock = lockedHarness ?? initialForm?.harnessId;
  const [form, setForm] = useState<PresetFormValue>(() =>
    initialForm !== undefined ? initialForm : lock ? { ...emptyPresetForm(), harnessId: lock } : emptyPresetForm(),
  );
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
      const row = await create.mutateAsync(toPresetPayload(form));
      onOpenChange(false);
      onCreated?.(row);
    } catch {
      // Stay open: the mutation's error renders beside the button that can
      // press it again.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>
            {initialForm !== undefined
              ? "Clone preset"
              : lock !== undefined
                ? `New preset for ${lockedName}`
                : "Create preset"}
          </DialogTitle>
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
        {create.error && <p className="text-destructive text-sm">{errMessage(create.error, "Failed")}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !form.harnessId}>
            {create.isPending ? "Creating…" : "Create preset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
