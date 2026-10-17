import { useEffect, useRef } from "react";
import type { SshSessionDraft } from "@/components/connect/ssh-session-draft";
import { SshPresetNameField } from "@/components/presets/ssh-preset-name-field";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useSshPresets } from "@/hooks/use-ssh-presets";
import { presetChoiceLabel } from "@/lib/preset-access";
import type { SshPreset } from "@/types/preset";

/** Picking fills the form; it never starts SSH or retains a previously chosen local key. */
export function SshPresetPicker({
  initialId,
  onApply,
  disabled,
  initialEligible = true,
}: {
  initialId?: string;
  onApply: (preset: SshPreset) => void;
  disabled: boolean;
  /** Local key selection also releases automatic application, while manual selection stays available. */
  initialEligible?: boolean;
}) {
  const query = useSshPresets();
  const initial = query.data?.find((p) => p.id === initialId);
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    // Busy or edited forms release the URL intent permanently, including while the query is pending.
    if (disabled || !initialEligible || !initialId) {
      consumed.current = true;
      return;
    }
    if (initial) {
      consumed.current = true;
      onApply(initial);
    }
  }, [initial, initialId, disabled, initialEligible, onApply]);
  if (query.isPending || query.isError) return <SshQueryStatus query={query} label="SSH presets" />;
  return (
    <>
      {initialId && !initial && (
        <p role="alert" className="text-destructive text-detail">
          This SSH preset is no longer available. Choose another preset or enter the connection details.
        </p>
      )}
      {!!query.data?.length && (
        <Field>
          <FieldLabel htmlFor="ssh-preset-picker">SSH preset</FieldLabel>
          <SearchableSelect
            id="ssh-preset-picker"
            value=""
            placeholder="Choose a preset"
            options={query.data.map((p) => ({
              value: p.id,
              label: presetChoiceLabel(p),
              searchText: p.destination,
              disabled,
              reason: disabled ? "Wait for the current connection attempt to finish." : undefined,
            }))}
            onValueChange={(id) => {
              const preset = query.data.find((p) => p.id === id);
              if (preset && !disabled) onApply(preset);
            }}
          />
        </Field>
      )}
    </>
  );
}

export function SaveSshPresetFields({
  draft,
  onChange,
  busy,
}: {
  draft: SshSessionDraft;
  onChange: (draft: SshSessionDraft) => void;
  busy: boolean;
}) {
  return (
    <FieldGroup>
      <Field className="flex-row items-center gap-3">
        <Checkbox
          id="ssh-save-preset"
          checked={draft.saveAsPreset ?? false}
          disabled={busy}
          onCheckedChange={(checked) => onChange({ ...draft, saveAsPreset: checked === true })}
        />
        <FieldLabel htmlFor="ssh-save-preset">Save as preset</FieldLabel>
      </Field>
      {draft.saveAsPreset && (
        <Field>
          <SshPresetNameField
            id="ssh-preset-name"
            label="Preset name"
            value={draft.presetName ?? ""}
            disabled={busy}
            onChange={(presetName) => onChange({ ...draft, presetName })}
          />
          <p className="text-detail text-muted-foreground">
            Saves these connection choices before starting. Keys from your machine and passwords aren’t saved.
          </p>
        </Field>
      )}
    </FieldGroup>
  );
}
