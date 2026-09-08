import { useNavigate } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";

/**
 * The sidebar's quick-launch dialog (spec 2026-09-03 sidebar-quickadd §4a).
 * `/new` and this dialog are two entry points over ONE contract: the shared
 * `NewSubshellForm` owns the fields, `useCreateSubshell` owns the POST, and a
 * success lands on the subshell page — the same thing `/new` does. The page
 * stays (deep links + e2e pin its field ids).
 */
export function LaunchSubshellDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const create = useCreateSubshell();
  const [form, setForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setForm(emptyNewSubshellForm());
    setError(null);
  }

  async function submit() {
    setError(null);
    try {
      const created = await create.mutateAsync(form);
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
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New subshell</DialogTitle>
          <DialogDescription>Launch an agent harness in a working directory.</DialogDescription>
        </DialogHeader>
        <NewSubshellForm value={form} onChange={setForm} />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !canSubmit(form)}>
            {create.isPending ? "Starting…" : "Start subshell"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
