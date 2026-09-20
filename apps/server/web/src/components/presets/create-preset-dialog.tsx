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
 * Base UI nests dialogs natively, so mounting this inside the launch dialog
 * works: Escape closes this one first. The mount IS the open (clone-dialog
 * posture): every open starts from a blank form and a cleared error for free.
 * A successful create invalidates the preset list (in `useCreatePreset`) and
 * hands the row to `onCreated` — the launch form selects it.
 */
export function CreatePresetDialog({
  open,
  onOpenChange,
  lockedHarness,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent id to lock the form to; absent = the unlocked /presets posture */
  lockedHarness?: string;
  /** Called with the created row (after the list invalidation) */
  onCreated?: (row: PresetRow) => void;
}): JSX.Element {
  const [form, setForm] = useState<PresetFormValue>(() =>
    lockedHarness ? { ...emptyPresetForm(), harnessId: lockedHarness } : emptyPresetForm(),
  );
  const create = useCreatePreset();
  // Only for the locked title's agent NAME — the catalog is already cached by
  // whoever raised this dialog, so this reads, it does not fetch twice.
  const { data: pluginData } = useInstancePlugins();
  const lockedName =
    lockedHarness !== undefined
      ? ((pluginData?.plugins ?? []).find((p) => p.id === lockedHarness)?.name ?? lockedHarness)
      : "";
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
          <DialogTitle>{lockedHarness !== undefined ? `New preset for ${lockedName}` : "Create preset"}</DialogTitle>
          <DialogDescription>
            Saved flags, env vars and restart policy.
            {lockedHarness !== undefined
              ? ` Every subshell you start with it launches ${lockedName} this way.`
              : chosenName !== null
                ? ` Every subshell you start with it launches ${chosenName} this way.`
                : ""}
          </DialogDescription>
        </DialogHeader>
        <PresetFields value={form} onChange={setForm} lockedHarness={lockedHarness} />
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
