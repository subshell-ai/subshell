import { ApiError, apiPost, Button, errMessage, Input } from "@internal/node-admin";
import { useStore } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";
import { FactList } from "@/components/fact-list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ErrorNotice, WarningNotice } from "@/components/ui/notice";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNodes } from "@/hooks/use-nodes";
import { useInvalidatePresets } from "@/hooks/use-presets";
import { type FieldProblems, makeForm, useSubmitDisabled, useSubmitDisabledReason } from "@/lib/form";
import { isDuplicatePresetName } from "@/lib/preset-errors";
import {
  type ImportedPreset,
  PRESET_FILE_MAX_BYTES,
  PresetFileSchema,
  parsePresetFile,
  presetImportPayload,
} from "@/lib/preset-file";

function importProblems(preset: ImportedPreset | null): FieldProblems {
  if (!preset) return { preset: "Choose a valid .preset file first." };
  const result = PresetFileSchema.safeParse({ format: "subshell-preset", version: 1, preset });
  if (!result.success) return { preset: result.error.issues[0]?.message ?? "Check the preset settings." };
  if (preset.kind === "agent" && preset.crossCommEnabled && !preset.nodeId)
    return { preset: "Choose a launch node for cross-subshell communication." };
  if (preset.kind === "ssh" && !preset.nodeId) return { preset: "Choose a connecting node." };
  if (preset.kind === "ssh" && preset.authentication === "remote" && !preset.keyHome)
    return { preset: "Choose a node to supply the SSH keys." };
  return {};
}

/** Parsing never writes. The explicit import uses the ordinary, permission-checked create API. */
export function ImportPresetDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (kind: "agent" | "ssh") => void;
}) {
  const invalidate = useInvalidatePresets();
  const nodes = useNodes();
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (nameError && !saving) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [nameError, saving]);
  const generation = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const form = makeForm({
    defaultValues: { preset: null as ImportedPreset | null },
    validator: ({ preset }) => importProblems(preset),
    onSubmit: async ({ preset }) => {
      if (reading || saving || !preset || Object.keys(importProblems(preset)).length) return;
      setSaving(true);
      setError(null);
      try {
        await apiPost("/api/presets", presetImportPayload(preset));
        await invalidate();
        onImported(preset.kind);
      } catch (err) {
        if (isDuplicatePresetName(err)) {
          setNameError("You already have a preset with this name. Choose a different name to import a copy.");
          return;
        }
        setError(
          err instanceof ApiError && err.status === 422
            ? "The SSH destination couldn't be verified. Review its connection choices in a new SSH preset before saving it."
            : errMessage(err, "Couldn't import this preset. Check its settings and try again."),
        );
      } finally {
        setSaving(false);
      }
    },
  });
  const preset = useStore(form.store, (state) => state.values.preset);
  const busy = reading || saving;
  const disabled = useSubmitDisabled(form, busy);
  const disabledReason = useSubmitDisabledReason(form, busy);
  async function choose(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setNameError(null);
    const current = ++generation.current;
    form.setFieldValue("preset", null);
    setError(null);
    if (file.size > PRESET_FILE_MAX_BYTES) {
      setReading(false);
      setError("Choose a preset file smaller than 1 MiB.");
      return;
    }
    setReading(true);
    try {
      const parsed = parsePresetFile(await file.text());
      if (current === generation.current) form.setFieldValue("preset", parsed.preset);
    } catch (err) {
      if (current === generation.current) setError(errMessage(err, "Couldn't read this preset file."));
    } finally {
      if (current === generation.current) setReading(false);
    }
  }
  function nodeField(label: string, key: "nodeId" | "keyHome", nullable: boolean) {
    if (!preset) return null;
    const value = key === "nodeId" ? preset.nodeId : preset.kind === "ssh" ? preset.keyHome : null;
    const choices = [
      ...(nullable ? [{ value: "none", label: "Choose when launching" }] : []),
      ...(nodes.data?.nodes ?? []).map((node) => ({ value: node.id, label: node.name })),
    ];
    if (value && !choices.some((choice) => choice.value === value))
      choices.push({ value, label: "Node unavailable on this instance" });
    return (
      <Field>
        <FieldLabel htmlFor={`import-${key}`}>{label}</FieldLabel>
        <Select
          value={value ?? (nullable ? "none" : "")}
          items={choices}
          onValueChange={(id) => {
            if (id) form.setFieldValue("preset", { ...preset, [key]: id === "none" ? null : id });
          }}
        >
          <SelectTrigger id={`import-${key}`} disabled={busy} disabledReason="Wait for the import to finish.">
            <SelectValue placeholder="Choose a node" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={formDialogOpenChange((open) => {
        if (!open && !saving) onClose();
      })}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import preset</DialogTitle>
          <DialogDescription>
            Choose an exported .preset file. Import creates a private copy in your account without starting a subshell.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <FieldGroup className="gap-4">
            <Field>
              <Input
                ref={picker}
                id="preset-file"
                className="sr-only"
                tabIndex={-1}
                aria-label="Preset file"
                type="file"
                accept=".preset,application/json"
                disabled={busy}
                onChange={(event) => void choose(event.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                className="self-start"
                disabled={busy}
                disabledReason={
                  reading ? "Wait for the file to finish validating." : "Wait for the preset to finish importing."
                }
                onClick={() => picker.current?.click()}
              >
                Choose preset file…
              </Button>
              {fileName && <p className="text-detail text-warning [overflow-wrap:anywhere]">{fileName}</p>}
            </Field>
            {reading && (
              <p role="status" className="text-detail text-muted-foreground">
                Validating file…
              </p>
            )}
            {preset && (
              <>
                <FactList rows={[{ label: "Preset type", value: preset.kind === "agent" ? "Agent" : "SSH" }]} />
                <Field>
                  <FieldLabel htmlFor="import-preset-name">Name</FieldLabel>
                  <Input
                    ref={nameInput}
                    id="import-preset-name"
                    aria-invalid={!!nameError}
                    aria-describedby={nameError ? "import-preset-name-error" : undefined}
                    value={preset.name}
                    maxLength={120}
                    disabled={busy}
                    onChange={(event) => {
                      setNameError(null);
                      form.setFieldValue("preset", { ...preset, name: event.target.value });
                    }}
                  />
                  {nameError && (
                    <p id="import-preset-name-error" role="alert" className="text-destructive text-detail">
                      {nameError}
                    </p>
                  )}
                </Field>
                {nodeField(preset.kind === "ssh" ? "Connect from" : "Launch node", "nodeId", preset.kind === "agent")}
                {preset.kind === "ssh" &&
                  preset.authentication === "remote" &&
                  nodeField("Use keys from", "keyHome", false)}
                <p className="text-detail text-muted-foreground">
                  Choose nodes on this instance. Access and availability are checked before the preset is saved.
                </p>
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer font-strong text-body">Review settings</summary>
                  <p className="mt-3 text-detail text-muted-foreground">Preset file format: version 1</p>
                  <pre className="mt-3 whitespace-pre-wrap font-mono text-detail [overflow-wrap:anywhere]">
                    {JSON.stringify(preset, null, 2)}
                  </pre>
                </details>
                <WarningNotice>
                  {preset.kind === "agent"
                    ? "Only import settings you trust. This file can contain environment secrets, command flags, and prompts that affect future launches."
                    : "Importing saves connection choices, not SSH keys or destination approvals. Those checks still apply when connecting."}
                </WarningNotice>
              </>
            )}
            {nodes.isError && preset && (
              <ErrorNotice>
                Couldn't load nodes.{" "}
                <Button type="button" variant="link" onClick={() => void nodes.refetch()}>
                  Retry
                </Button>
              </ErrorNotice>
            )}
            {error && <ErrorNotice>{error}</ErrorNotice>}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              disabledReason="Wait for the preset to finish importing."
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={disabled} disabledReason={disabledReason}>
              {saving ? "Importing…" : "Import preset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
