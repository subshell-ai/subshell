import { Button } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useRef, useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import {
  canSubmit,
  emptyNewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/launch-form-rules";
import { NewSubshellForm } from "@/components/subshell-picker/new-subshell-form";
import { type SubshellKind, SubshellKindPicker } from "@/components/subshell-picker/subshell-kind-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import type { sshConnectSearch } from "@/lib/ssh-connect-search";

/**
 * The rail's quick-launch dialog (spec 2026-09-03 sidebar-quickadd §4a), and
 * since 2026-09-11 the ONLY new-subshell surface: `/new` used to render a
 * second copy of this form as a full-page card and now simply raises this
 * dialog over the list. The shared `NewSubshellForm` owns the fields,
 * `useCreateSubshell` owns the POST, and a success lands on the subshell page.
 */
export function LaunchSubshellDialog({
  open,
  onOpenChange,
  initialSsh,
}: {
  initialSsh?: ReturnType<typeof sshConnectSearch>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [sshPending, setSshPending] = useState(false);
  const [sshDraft, setSshDraft] = useState(() => sshSessionDraft(initialSsh));
  const [kind, setKind] = useState<SubshellKind>(initialSsh ? "ssh" : "agent");
  const contentRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const create = useCreateSubshell();
  const [form, setForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSshDraft(sshSessionDraft(initialSsh));
    setForm(emptyNewSubshellForm());
    setError(null);
    setKind("agent");
  }

  async function submit() {
    setError(null);
    try {
      const created = await create.mutateAsync(form);
      // A prompt that did not land announces itself through the hook's
      // toast, across this navigation (spec 2026-09-28); the launch itself
      // is a success and the subshell page is the right destination.
      onOpenChange(false);
      reset();
      void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch (err) {
      // Node-aware copy: an offline remote pick answers 409 NODE_OFFLINE and
      // gets the actionable line (same helper as /new and the add-dialog).
      setError(createSubshellErrorMessage(err, "Failed to create subshell"));
    }
  }

  return (
    <Dialog
      open={open}
      // A half-filled launch form is not disposable (ruling 2026-09-30):
      // only a deliberate act closes this - X, Cancel, or a successful add.
      onOpenChange={formDialogOpenChange((next) => {
        if (sshPending || create.isPending) return;
        onOpenChange(next);
        if (!next) reset();
      })}
    >
      <DialogContent
        className="sm:max-w-xl"
        ref={contentRef}
        initialFocus={(interaction) =>
          interaction === "touch"
            ? true
            : (contentRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? true)
        }
      >
        <DialogHeader>
          <DialogTitle>New subshell</DialogTitle>
          <DialogDescription>Start an agent, a terminal, or an SSH session in a subshell.</DialogDescription>
        </DialogHeader>
        <SubshellKindPicker value={kind} onChange={setKind} disabled={sshPending || create.isPending} />
        {kind === "ssh" && open ? (
          <ConnectPanel
            draft={sshDraft}
            onDraftChange={setSshDraft}
            onPendingChange={setSshPending}
            initial={initialSsh}
            onLeave={() => onOpenChange(false)}
            onCreated={(id) => {
              onOpenChange(false);
              reset();
              void navigate({ to: "/subshells/$id", params: { id } });
            }}
          />
        ) : (
          <>
            <NewSubshellForm value={form} onChange={setForm} onLeave={() => onOpenChange(false)} />
            {error && <p className="text-destructive text-detail">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={create.isPending || !canSubmit(form)}>
                {create.isPending ? "Starting…" : "Start subshell"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
