import { errMessage, Input } from "@internal/node-admin";
import { useState } from "react";
import { useBrowserKeySelection } from "@/components/connect/browser-key-fields";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import { SshWizard } from "@/components/connect/ssh-wizard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useSshReadiness } from "@/hooks/use-ssh";
import { useSaveSshPreset } from "@/hooks/use-ssh-presets";
import { sshDraftFromPreset, sshPresetPayload } from "@/lib/ssh-preset";
import type { SshPreset } from "@/types/preset";

/** A fresh mount is one editing session, including clones. No credential is requested here. */
export function SshPresetEditor({
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
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ssh-editor-name">Name</FieldLabel>
            <Input
              id="ssh-editor-name"
              value={name}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, presetName: event.target.value })}
            />
          </Field>
        </FieldGroup>
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
          refusal={
            save.error
              ? errMessage(save.error, "Couldn’t save this preset. Check the connection details and try again.")
              : undefined
          }
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
