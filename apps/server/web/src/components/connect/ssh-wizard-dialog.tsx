import { Button } from "@internal/node-admin";
import { useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import type { SshInitialChoices, SshWizardIntent } from "@/components/connect/ssh-session-draft";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";

/** Settings entry mounts the same content only while open; it can return to the connection form in-place. */
export function SshWizardDialog({ initial, intent }: { initial?: SshInitialChoices; intent?: SshWizardIntent }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        SSH Wizard
      </Button>
      <Dialog
        open={open}
        onOpenChange={formDialogOpenChange((next) => {
          if (!busy) setOpen(next);
        })}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>SSH Wizard</DialogTitle>
            <DialogDescription>
              Connect to a destination, prepare a machine, or use keys from another machine.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <ConnectPanel
              initial={initial}
              startInWizard
              wizardIntent={intent}
              onPendingChange={setBusy}
              onDone={() => setOpen(false)}
              onLeave={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
