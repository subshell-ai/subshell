import { apiPost, Button, errMessage, Input } from "@internal/node-admin";
import { normalizeLabel } from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { type FieldProblems, makeForm, useSubmitDisabled, useSubmitDisabledReason } from "@/lib/form";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { defaultWorkspaceName, uniqueWorkspaceName, WORKSPACE_NAME_MAX } from "@/lib/workspace-name";

/**
 * Creates a workspace with a name and opens it empty (spec 2026-09-03
 * sidebar-quickadd §4b, revised 2026-11-10) — what the sidebar's Workspaces
 * `+`, the /workspaces page's button and the landings open instead of the
 * old immediate create.
 *
 * Subshells are not chosen here any more: existing ones join the workspace by
 * being clicked in the sidebar or dragged onto it, and a fresh launch files
 * itself, so this dialog only owns the name.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const invalidate = useInvalidateWorkspaces();
  const { data: workspaces } = useWorkspaces();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The caret rule: a complaint waits until the field has been left.
  const [nameFocused, setNameFocused] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);

  const draft = makeForm({
    // Seeded before the open effect runs, so the first frame has a valid,
    // submittable name instead of a disabled button.
    defaultValues: { name: defaultWorkspaceName() },
    validator: ({ name }): FieldProblems =>
      normalizeLabel(name, WORKSPACE_NAME_MAX) ? {} : { name: "Enter a workspace name." },
    onSubmit: () => submit(),
  });
  const { name } = useStore(draft.store, (state) => state.values);
  const submitDisabled = useSubmitDisabled(draft, creating);
  const submitDisabledReason = useSubmitDisabledReason(draft, creating);

  // The default trades on the same-minute stamp, so names already held are
  // read ONCE per open: a list that settles afterwards must not rewrite the
  // field while the person is typing.
  const takenAtOpen = useRef<string[]>([]);
  takenAtOpen.current = Array.isArray(workspaces) ? workspaces.map((workspace) => workspace.name) : [];
  const setName = useCallback((value: string) => draft.setFieldValue("name", value), [draft]);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setCreating(false);
    setNameFocused(false);
    setNameTouched(false);
    setName(uniqueWorkspaceName(defaultWorkspaceName(), takenAtOpen.current));
  }, [open, setName]);

  function reset() {
    setError(null);
    setCreating(false);
  }

  function dismiss() {
    if (creating) return;
    onOpenChange(false);
    reset();
  }

  async function submit() {
    if (creating) return;
    const cleaned = normalizeLabel(name, WORKSPACE_NAME_MAX);
    if (!cleaned) return;
    setError(null);
    setCreating(true);
    let id: string;
    try {
      const created = await apiPost<{ id: string }>("/api/workspaces", { name: cleaned });
      id = created.id;
    } catch (err) {
      setError(errMessage(err, "Failed to create workspace"));
      setCreating(false);
      return;
    }
    await invalidate();
    onOpenChange(false);
    reset();
    void navigate({ to: "/workspaces/$id", params: { id }, search: {} });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={formDialogOpenChange((next) => {
        if (creating) return;
        if (next) onOpenChange(true);
        else dismiss();
      })}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>Name it now; you can add subshells inside.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void draft.handleSubmit();
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={() => setNameFocused(true)}
            onBlur={() => {
              setNameFocused(false);
              setNameTouched(true);
            }}
            maxLength={WORKSPACE_NAME_MAX}
            aria-label="Workspace name"
            aria-invalid={!normalizeLabel(name, WORKSPACE_NAME_MAX)}
            autoFocus
          />
          {nameTouched && !nameFocused && !normalizeLabel(name, WORKSPACE_NAME_MAX) && (
            <p role="alert" className={`mt-1 ${REQUIREMENT_CAPTION_CLASS}`}>
              Enter a workspace name.
            </p>
          )}
          {error && <p className="mt-1 text-destructive text-detail">{error}</p>}
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={dismiss}
              disabled={creating}
              disabledReason="Wait for the workspace to be created."
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitDisabled}
              disabledReason={creating ? "Wait for the workspace to be created." : submitDisabledReason}
            >
              {creating ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
