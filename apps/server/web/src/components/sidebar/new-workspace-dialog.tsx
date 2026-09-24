import { apiPost, Button, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { ExistingSubshellList } from "@/components/subshell-picker/existing-subshell-list";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { defaultWorkspaceName } from "@/lib/workspace-name";

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
  const { data: subshells, isError: loadFailed, isLoading: loading } = useSubshellsList();
  const create = useCreateSubshell();

  const [mode, setMode] = useState<Mode>("existing");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm());
  /** Ordered ids to attach; checkbox toggles and successful launches append here. */
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [creating, setCreating] = useState(false);
  // Set when the workspace exists but at least one pane failed — the footer
  // becomes Enter (the workspace is real; the missing panes are addable there).
  const [createdId, setCreatedId] = useState<string | null>(null);

  function reset() {
    setMode("existing");
    setQuery("");
    setForm(emptyNewSubshellForm());
    setSelected([]);
    setError(null);
    setLaunching(false);
    setCreating(false);
    setCreatedId(null);
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function enter(id: string) {
    onOpenChange(false);
    reset();
    void navigate({ to: "/workspaces/$id", params: { id } });
  }

  /** Launches from the New half and checks the result into the selection. */
  async function launchAndAdd() {
    setError(null);
    setLaunching(true);
    try {
      const created = await create.mutateAsync(form);
      setSelected((prev) => [...prev, created.id]);
      setForm(emptyNewSubshellForm());
      // The launched row is now in the (invalidated) list — show it checked.
      setMode("existing");
    } catch (err) {
      setError(createSubshellErrorMessage(err, "Failed to launch subshell"));
    } finally {
      setLaunching(false);
    }
  }

  async function submit() {
    setError(null);
    setCreating(true);
    let id: string;
    try {
      const created = await apiPost<{ id: string }>("/api/workspaces", { name: defaultWorkspaceName() });
      id = created.id;
    } catch (err) {
      setError(errMessage(err, "Failed to create workspace"));
      setCreating(false);
      return;
    }
    let failed = 0;
    for (const subshellId of selected) {
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>Start it with subshells already tiled in, or empty.</DialogDescription>
        </DialogHeader>

        <Segmented
          ariaLabel="What to add"
          options={[
            { value: "existing", label: "Existing subshells" },
            { value: "new", label: "New subshell" },
          ]}
          value={mode}
          onChange={setMode}
        />

        {createdId ? (
          // The workspace exists; the error line above says which adds failed.
          <p className="text-muted-foreground text-sm">The workspace is created. Enter it to add the rest.</p>
        ) : mode === "existing" ? (
          <ExistingSubshellList
            subshells={subshells ?? []}
            query={query}
            onQueryChange={setQuery}
            loadFailed={loadFailed}
            loading={loading}
            selected={new Set(selected)}
            onToggle={toggle}
          />
        ) : (
          <NewSubshellForm value={form} onChange={setForm} onLeave={() => onOpenChange(false)} />
        )}

        {error && <p className="text-destructive text-detail">{error}</p>}
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
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating || launching}>
                Cancel
              </Button>
              {mode === "new" && (
                <Button onClick={() => void launchAndAdd()} disabled={launching || !canSubmit(form)}>
                  {launching ? "Launching…" : "Launch & add"}
                </Button>
              )}
              <Button onClick={() => void submit()} disabled={creating || launching}>
                {creating ? "Creating…" : "Create workspace"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
