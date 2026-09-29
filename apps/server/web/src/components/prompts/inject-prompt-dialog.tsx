import { apiPost, Button, errMessage } from "@internal/node-admin";
import { useRef, useState } from "react";
import { PromptPickerDialog } from "@/components/prompts/prompt-picker-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The subshell menu's "Inject prompt..." (spec 2026-09-28): the shared
 * picker in single-select, then a confirm step that says exactly what the
 * button does. The text is TYPED, never submitted: a submitted line can
 * corrupt a harness mid-turn, so the person reviews it at the prompt and
 * presses Enter themselves. This is the browser's first consumer of
 * `POST /api/subshells/:id/input`; the server answers the running/offline
 * facts, so failures render here and keep the dialog open.
 */
export function InjectPromptDialog({
  subshellId,
  subshellName,
  open,
  onOpenChange,
}: {
  subshellId: string;
  subshellName: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [picked, setPicked] = useState<PromptBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The picker closes itself on a pick (decisive action, live report
  // 2026-09-29), and this component's owner unmounts it when `open` flips
  // false — so a pick-driven close must ADVANCE here, never reach the
  // owner, or the selection dies with the subtree before the confirm step
  // can render (round-5 review: the inject path had no test and broke).
  // A close that was NOT a pick (Done, Escape) is the person leaving.
  const justPicked = useRef(false);

  async function send() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/subshells/${subshellId}/input`, { text: picked.body, submit: false });
      onOpenChange(false);
    } catch (err) {
      // The row died or its node went dark since the menu drew: the server's
      // own sentence, on the dialog that failed.
      setError(errMessage(err, "The prompt could not be typed into the pane"));
    } finally {
      setBusy(false);
    }
  }

  if (!picked) {
    return (
      <PromptPickerDialog
        open={open}
        mode="single"
        onPick={(block) => {
          justPicked.current = true;
          setPicked(block);
        }}
        onOpenChange={(next) => {
          if (!next && justPicked.current) {
            justPicked.current = false;
            return;
          }
          onOpenChange(next);
        }}
      />
    );
  }

  // The confirm step is the SAME Dialog component (the picker's pick-close
  // was absorbed above; the menu caller keeps `open` true across both):
  // name, body, what the button does, send.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Inject "{picked.description}" into "{subshellName}"
          </DialogTitle>
          <DialogDescription>
            This types into the pane without sending. Press Enter there when you are ready.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-sm">
          {picked.body}
        </pre>
        {error && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setPicked(null)} disabled={busy}>
            Back
          </Button>
          <Button onClick={() => void send()} disabled={busy}>
            {busy ? "Typing…" : "Type into pane"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
