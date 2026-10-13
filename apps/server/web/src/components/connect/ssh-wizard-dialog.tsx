import { Button } from "@internal/node-admin";
import { useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import type { SshInitialChoices } from "@/components/connect/ssh-session-draft";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";

/** Settings entry mounts the same content only while open; it can return to the connection form in-place. */
export function SshWizardDialog({ initial }: { initial?: SshInitialChoices }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Set up SSH
      </Button>
      <Dialog
        open={open}
        onOpenChange={formDialogOpenChange((next) => {
          if (!busy) setOpen(next);
        })}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Set up SSH</DialogTitle>
            <DialogDescription>Choose where to connect from and which SSH keys to use.</DialogDescription>
          </DialogHeader>
          {open && (
            <ConnectPanel
              initial={initial}
              startInWizard
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
