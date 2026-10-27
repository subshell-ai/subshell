import { apiPost, Button, errMessage } from "@internal/node-admin";
import { useStore } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import { ExistingSubshellList } from "@/components/subshell-picker/existing-subshell-list";
import {
  canSubmit,
  emptyNewSubshellForm,
  launchDisabledReason,
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
import { Segmented } from "@/components/ui/segmented";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { splitLaunchError } from "@/lib/display-refusal-routing";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { defaultWorkspaceName, uniqueWorkspaceName } from "@/lib/workspace-name";

/** Which half of the dialog is showing (same shape as the add-subshell dialog). */
type Mode = "existing" | "new";

/**
 * Creates a workspace WITH subshells already on it (spec 2026-09-03
 * sidebar-quickadd §4b) — what the sidebar's Workspaces `+` and the
 * /workspaces page's button open instead of the old immediate create.
 *
 * Deliberately has no placement control: a fresh workspace has no focused
 * pane to split from, and the dock's reconciliation lays every pane of a
 * workspace with no saved layout out as tabs.
 *
 * Submit order is workspace → panes, sequentially, collecting failures rather
 * than aborting: the workspace existing but a pane missing is recoverable
 * from inside it; a pane posted to a workspace that was never created is not.
 * Zero selected is a valid answer — it means today's old behavior (an empty
 * workspace you name and fill inside).
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
  const { data: roster, isError: loadFailed, isLoading: loading } = useSubshellsList();
  // Agent-created helpers aren't candidates for a human's workspace.
  const subshells = roster?.filter((subshell) => subshell.crossAgent !== true);
  // Names already taken, so a same-minute second create does not send the
  // identical default: two tree branches reading the same is confusion, not
  // a server rule — the unique `(user, name)` index left with migration 0058,
  // and nothing 409s on a repeated name anymore.
  const { data: workspaces } = useWorkspaces();
  // Placement is this dialog's own decision (the workspace it was opened
  // from, or the split's, or the workspace it just created) — the hook must
  // not open a SECOND workspace around the pane. See `useCreateSubshell`.
  const create = useCreateSubshell({ autoFile: false });

  const [sshDraft, setSshDraft] = useState(() => sshSessionDraft());
  const draft = makeForm({
    defaultValues: { kind: "agent" as SubshellKind, mode: "existing" as Mode, form: emptyNewSubshellForm() },
    validator: ({ mode, kind, form }): Record<string, string> =>
      mode !== "new" || (kind === "agent" && canSubmit(form))
        ? {}
        : {
            form:
              kind === "ssh"
                ? "Connect the SSH subshell first."
                : (launchDisabledReason(form) ?? "Complete the launch form."),
          },
    onSubmit: () => submit(),
  });
  const { kind, mode, form } = useStore(draft.store, (state) => state.values);
  const setKind = useCallback((value: SubshellKind) => draft.setFieldValue("kind", value), [draft]);
  const setMode = useCallback((value: Mode) => draft.setFieldValue("mode", value), [draft]);
  const setForm = useCallback((value: NewSubshellFormValue) => draft.setFieldValue("form", value), [draft]);
  const [query, setQuery] = useState("");
  /** Ordered ids to attach; checkbox toggles and successful launches append here. */
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A display refusal reads as the checkbox's own result, so the field
  // renders it; everything else keeps the form-level line.
  const [launching, setLaunching] = useState(false);
  const [creating, setCreating] = useState(false);
  const submitDisabled = useSubmitDisabled(draft, creating || launching);
  // Set when the workspace exists but at least one pane failed — the footer
  // becomes Enter (the workspace is real; the missing panes are addable there).
  const [createdId, setCreatedId] = useState<string | null>(null);

  // The landing segment is decided ONCE per open (operator finding
  // 2026-10-20): an instance with no subshells at all must not open on an
  // "Existing subshells" tab that can only hold a dead end. While the read is
  // still loading its size is unknown, so "existing" stands, and a list that
  // settles AFTER the dialog is open must not yank the segment out from under
  // the person. The current read therefore rides a ref, and the effect keys
  // on `open` alone.
  const readAtOpen = useRef({ loading, subshells });
  readAtOpen.current = { loading, subshells };
  useEffect(() => {
    if (!open) return;
    const read = readAtOpen.current;
    setMode(!read.loading && read.subshells !== undefined && read.subshells.length === 0 ? "new" : "existing");
  }, [open, setMode]);

  function reset() {
    setSshDraft(sshSessionDraft());
    setMode("existing");
    setKind("agent");
    setQuery("");
    setForm(emptyNewSubshellForm());
    setSelected([]);
    setError(null);
    setLaunching(false);
    setCreating(false);
    setCreatedId(null);
  }

  function toggle(id: string) {
    if (creating || launching) return;
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function enter(id: string) {
    onOpenChange(false);
    reset();
    void navigate({ to: "/workspaces/$id", params: { id }, search: {} });
  }

  async function submit() {
    if (creating || launching || (mode === "new" && (kind !== "agent" || !canSubmit(form)))) return;
    setError(null);
    setCreating(true);
    let toAdd = selected;
    if (mode === "new") {
      try {
        const launched = await create.mutateAsync(form);
        toAdd = [...selected, launched.id];
        // Keep the successful launch selected if workspace creation fails;
        // retrying must not start another process.
        setSelected(toAdd);
        setMode("existing");
        setForm(emptyNewSubshellForm());
      } catch (err) {
        setError(createSubshellErrorMessage(err, "Failed to launch subshell"));
        setCreating(false);
        return;
      }
    }
    let id: string;
    try {
      const taken = Array.isArray(workspaces) ? workspaces.map((w) => w.name) : [];
      const created = await apiPost<{ id: string }>("/api/workspaces", {
        name: uniqueWorkspaceName(defaultWorkspaceName(), taken),
      });
      id = created.id;
    } catch (err) {
      setError(errMessage(err, "Failed to create workspace"));
      setCreating(false);
      return;
    }
    let failed = 0;
    for (const subshellId of toAdd) {
      try {
        await apiPost(`/api/workspaces/${id}/panes`, { subshellId });
      } catch {
        failed += 1;
      }
    }
    await invalidate();
    setCreating(false);
    if (failed > 0) {
      setCreatedId(id);
      setError(
        `Workspace created, but ${failed} subshell${failed === 1 ? "" : "s"} could not be added. You can add them from inside.`,
      );
      return;
    }
    enter(id);
  }

  // Where a refusal renders: the Virtual display checkbox owns it while that control
  // is on screen and switched on, and the form line takes it back when either is
  // not, so a display refusal is never both invisible and orphaned.
  const { field: displayLaunchError, form: formLaunchError } = splitLaunchError(
    error,
    !createdId && mode !== "existing" && !(kind === "ssh" && open) && form.virtualDisplay === true,
  );
  return (
    <Dialog
      open={open}
      // A half-filled launch form is not disposable (ruling 2026-09-30):
      // only a deliberate act closes this - X, Cancel, or a successful add.
      onOpenChange={formDialogOpenChange((next) => {
        if (creating || launching) return;
        onOpenChange(next);
        if (!next) reset();
      })}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>Start it with subshells already tiled in, or empty.</DialogDescription>
        </DialogHeader>

        <fieldset disabled={creating || launching}>
          <Segmented
            ariaLabel="What to add"
            options={[
              { value: "existing", label: "Existing subshells" },
              { value: "new", label: "New subshell" },
            ]}
            value={mode}
            onChange={(next) => {
              if (!launching) setMode(next);
            }}
          />
        </fieldset>
        {createdId ? (
          // The workspace exists; the error line above says which adds failed.
          <p className="text-muted-foreground text-sm">The workspace is created. Enter it to add the rest.</p>
        ) : mode === "existing" ? (
          <ExistingSubshellList
            subshells={subshells ?? []}
            // Nothing is a member yet (the workspace does not exist), so the
            // eligible roster is the candidate list; 0 means none to add.
            totalCount={subshells?.length}
            query={query}
            onQueryChange={setQuery}
            loadFailed={loadFailed}
            loading={loading}
            selected={new Set(selected)}
            onToggle={toggle}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <SubshellKindPicker value={kind} onChange={setKind} disabled={launching || creating} />
            {kind === "ssh" && open ? (
              <ConnectPanel
                draft={sshDraft}
                onDraftChange={setSshDraft}
                onPendingChange={setLaunching}
                onLeave={() => onOpenChange(false)}
                onCreated={(id) => {
                  setSelected((prev) => [...prev, id]);
                  setMode("existing");
                }}
              />
            ) : (
              <NewSubshellForm
                value={form}
                onChange={setForm}
                onLeave={() => onOpenChange(false)}
                launchError={displayLaunchError}
              />
            )}
          </div>
        )}

        {formLaunchError && <p className="text-destructive text-detail">{formLaunchError}</p>}
        {!createdId && selected.length > 0 && (
          <p className="text-detail text-muted-foreground">
            {selected.length === 1 ? "1 subshell" : `${selected.length} subshells`} to add
          </p>
        )}

        <DialogFooter>
          {createdId ? (
            <Button onClick={() => enter(createdId)}>Enter workspace</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={creating || launching}
                disabledReason={"Wait for the workspace action to finish."}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void draft.handleSubmit()}
                disabled={submitDisabled}
                disabledReason={
                  creating || launching
                    ? "Wait for the workspace action to finish."
                    : kind === "ssh"
                      ? "Connect the SSH subshell first."
                      : launchDisabledReason(form)
                }
              >
                {creating ? "Creating…" : "Create workspace"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
