import { ApiError, Button, errMessage } from "@internal/node-admin";
import { useState } from "react";
import { useBrowserKeySelection } from "@/components/connect/browser-key-fields";
import { isSshResolveRefusal, refusalFromOutcome } from "@/components/connect/ssh-refusal";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import { SshWizard } from "@/components/connect/ssh-wizard";
import { PresetDetails } from "@/components/presets/preset-details";
import { SshPresetNameField } from "@/components/presets/ssh-preset-name-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { useSshReadiness } from "@/hooks/use-ssh";
import { useSaveSshPreset } from "@/hooks/use-ssh-presets";
import { canEditPreset } from "@/lib/preset-access";
import { isDuplicatePresetName } from "@/lib/preset-errors";
import { sshDraftFromPreset, sshPresetPayload } from "@/lib/ssh-preset";
import type { SshPreset } from "@/types/preset";

/**
 * A refused save in words. The resolve refusal (422) carries the outcome in
 * the body, not an error sentence, so read the cause there rather than
 * rendering an `API 422:` JSON slice; everything else keeps the generic
 * message. Same doctrine as `ssh-refusal.ts` for the launch panel.
 */
function presetSaveRefusal(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) {
    const outcome =
      typeof error.body === "object" && error.body !== null ? (error.body as { outcome?: unknown }).outcome : undefined;
    if (isSshResolveRefusal(outcome)) return refusalFromOutcome(outcome);
  }
  return errMessage(error, "Couldn’t save this preset. Check the connection details and try again.");
}

/** A fresh mount is one editing session, including clones. No credential is requested here. */
export function SshPresetEditor(props: { preset?: SshPreset; cloneName?: string; onClose: () => void }) {
  if (props.preset && props.cloneName === undefined && !canEditPreset(props.preset)) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>View SSH preset</DialogTitle>
            <DialogDescription>
              You have view access. You can use or clone this preset, but you can't change it.
            </DialogDescription>
          </DialogHeader>
          <PresetDetails preset={props.preset} />
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    );
  }
  return <EditableSshPreset {...props} />;
}

function EditableSshPreset({
  preset,
  cloneName,
  onClose,
}: {
  preset?: SshPreset;
  cloneName?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    ...(preset ? sshDraftFromPreset(preset) : sshSessionDraft()),
    presetName: cloneName ?? preset?.name ?? "",
  }));
  const name = draft.presetName ?? "";
  const readiness = useSshReadiness();
  const browserKey = useBrowserKeySelection();
  const save = useSaveSshPreset();
  const duplicateName = isDuplicatePresetName(save.error);
  const editing = !!preset && cloneName === undefined;
  return (
    <Dialog
      open
      onOpenChange={formDialogOpenChange((open) => {
        if (!open && !save.isPending) onClose();
      })}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {cloneName !== undefined ? "Clone SSH preset" : editing ? "Edit SSH preset" : "Create SSH preset"}
          </DialogTitle>
          <DialogDescription>
            Save connection choices for next time. Saving doesn’t start a connection or approve a destination’s
            identity.
          </DialogDescription>
        </DialogHeader>
        <SshPresetNameField
          id="ssh-editor-name"
          label="Name"
          value={name}
          disabled={save.isPending}
          serverError={
            duplicateName ? "You already have an SSH preset with that name. Choose another name." : undefined
          }
          onChange={(presetName) => {
            save.reset();
            setDraft({ ...draft, presetName });
          }}
        />
        <SshWizard
          draft={draft}
          onDraftChange={(next) => setDraft({ ...next, presetName: next.presetName ?? "" })}
          browserKey={browserKey}
          machines={readiness.data?.machines ?? []}
          readiness={readiness}
          busy={save.isPending}
          onCancel={onClose}
          onLeave={onClose}
          presetEditor={{
            name,
            unchangedDestination:
              editing && draft.nodeId === preset.nodeId && draft.destination.typed === preset.destination,
          }}
          refusal={save.error && !duplicateName ? presetSaveRefusal(save.error) : undefined}
          onStart={async () => {
            try {
              const payload = sshPresetPayload(draft, name, preset?.description ?? "");
              if (preset && draft.destination.typed === preset.destination) payload.alias = preset.alias;
              await save.mutateAsync({ id: editing ? preset.id : undefined, payload });
              onClose();
            } catch {
              /* The mutation keeps the error beside the form. */
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
