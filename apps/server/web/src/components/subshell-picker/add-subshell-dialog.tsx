import { Button, errMessage } from "@internal/node-admin";
import { type JSX, useEffect, useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import { LaunchRefusal } from "@/components/launch-error-line";
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
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { displayFieldOwnsRefusal, splitLaunchError } from "@/lib/display-refusal-routing";
import type { SplitDirection } from "@/types/workspace";

/** Which half of the dialog is showing. */
type Mode = "existing" | "new";

/**
 * Adds a subshell to a workspace: an existing one picked from a searchable
 * list, or a brand-new one. Both join the workspace as tabs.
 *
 * Both halves live in one dialog because they answer the same question —
 * "what goes in this new pane?". Users arrange splits by dragging tabs.
 *
 * It takes IDS to exclude rather than the workspace's panes (spec 2026-09-14
 * §3): splitting from a subshell opens this same dialog before any workspace
 * exists, so there are no panes to hand it — only the one subshell that must
 * not be offered as its own second pane.
 */
export function AddSubshellDialog({
  open,
  onOpenChange,
  excludeSubshellIds,
  initialForm,
  title,
  description,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Subshells to leave out of the list — the ones already on this workspace, or the one being split. */
  excludeSubshellIds: string[];
  /**
   * Seeds the New-subshell half, merged over the empty form — and returned
   * to by `reset()`, so a cancelled launch starts from the same place the
   * dialog opened at. A split passes the current subshell's plugin, node and
   * directory so the New half starts as "another one like this".
   */
  initialForm?: Partial<NewSubshellFormValue>;
  /**
   * The dialog's heading. Defaults to "Add a subshell"; the Split flow passes
   * the IDE word "Split" instead (operator ruling 2026-09-27), so the dialog
   * is named by the button that opened it — the button itself is icon-only
   * now, and this heading is where the word lives.
   */
  title?: string;
  /** The line under the heading; the Split flow says what a split DOES. */
  description?: string;
  /** Adds `subshellId` to the workspace at `direction`. */
  onAdd: (subshellId: string, direction: SplitDirection) => Promise<unknown>;
}): JSX.Element {
  const { data: subshells, isError: subshellsFailed, isLoading: subshellsLoading } = useSubshellsList();
  // Placement is this dialog's own decision (the workspace it was opened
  // from, or the split's, or the workspace it just created) — the hook must
  // not open a SECOND workspace around the pane. See `useCreateSubshell`.
  const create = useCreateSubshell({ autoFile: false });

  const [sshDraft, setSshDraft] = useState(() => sshSessionDraft({ node: initialForm?.nodeId }));
  const [kind, setKind] = useState<SubshellKind>("agent");
  const [mode, setMode] = useState<Mode>("existing");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<NewSubshellFormValue>(() => ({ ...emptyNewSubshellForm(), ...initialForm }));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal naming the virtual display is the checkbox's own result, so it
  // renders inside the field; everything else keeps the form-level line.

  const excluded = new Set(excludeSubshellIds);
  const available = (subshells ?? []).filter((s) => s.crossAgent !== true && !excluded.has(s.id));
  const newOnly = !subshellsLoading && !subshellsFailed && subshells !== undefined && available.length === 0;
  const visibleMode = newOnly ? "new" : mode;
  // Keep a draft open if a refetch discovers another subshell while typing.
  useEffect(() => {
    if (open && newOnly) setMode("new");
  }, [open, newOnly]);

  /** Resets everything the next open should not inherit. */
  function reset() {
    setSshDraft(sshSessionDraft({ node: initialForm?.nodeId }));
    setMode("existing");
    setKind("agent");
    setQuery("");
    setForm({ ...emptyNewSubshellForm(), ...initialForm });
    setBusyId(null);
    setCreating(false);
    setError(null);
  }

  function dismiss() {
    if (creating || busyId !== null) return;
    onOpenChange(false);
    reset();
  }

  /** Adds an existing subshell, closing the dialog on success. */
  async function handlePick(subshellId: string) {
    setError(null);
    setBusyId(subshellId);
    try {
      await onAdd(subshellId, "within");
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(errMessage(err, "Failed to add subshell"));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Creates a subshell and adds it. If the subshell is created but adding it
   * fails, the subshell is left alone rather than deleted — it is still
   * reachable from the subshells page (the create hook invalidated the list,
   * so it is already there), and adding it from here again is one more
   * click.
   */
  async function handleCreate() {
    setError(null);
    setCreating(true);

    let created: { id: string };
    try {
      created = await create.mutateAsync(form);
    } catch (err) {
      // Node-aware copy: a remote pick that raced the picker answers 409
      // NODE_OFFLINE and gets the actionable line (lib/create-subshell-error).
      setError(createSubshellErrorMessage(err, "Failed to create subshell"));
      setCreating(false);
      return;
    }

    try {
      await onAdd(created.id, "within");
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(
        `Subshell was created but could not be added (${errMessage(err, "unknown error")}). Add it from the list instead.`,
      );
      setMode("existing");
    } finally {
      setCreating(false);
    }
  }

  // Where a refusal renders: the Virtual display checkbox owns it while that control
  // is on screen and switched on, and the form line takes it back when either is
  // not, so a display refusal is never both invisible and orphaned.
  // ONE variable decides "the agent branch is on screen", and both the split
  // below and the JSX that mounts `NewSubshellForm` read it. Written twice, the
  // two can drift, and the drift is silent: a refusal handed to a field that is
  // not mounted, with the form line empty as well, tells nobody anything.
  const agentBranch = visibleMode !== "existing" && !(kind === "ssh" && open);
  const { field: displayLaunchError, form: formLaunchError } = splitLaunchError(
    error,
    displayFieldOwnsRefusal({ mounted: agentBranch, virtualDisplay: form.virtualDisplay }),
  );
  return (
    <Dialog
      open={open}
      // A half-filled launch form is not disposable (ruling 2026-09-30):
      // only a deliberate act closes this - X, Cancel, or a successful add.
      onOpenChange={formDialogOpenChange((next) => {
        if (creating) return;
        if (next) onOpenChange(true);
        else dismiss();
      })}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? (newOnly ? "New subshell" : "Add a subshell")}</DialogTitle>
          <DialogDescription>
            {description ??
              (newOnly
                ? "Launch an agent or terminal in this workspace."
                : "Pick one you already have, or launch a new one.")}
          </DialogDescription>
        </DialogHeader>

        {!newOnly && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <fieldset disabled={creating || busyId !== null}>
              <Segmented
                ariaLabel="What to add"
                className="gap-1"
                options={[
                  { value: "existing", label: "Existing subshell" },
                  { value: "new", label: "New subshell" },
                ]}
                value={visibleMode}
                onChange={(next) => {
                  if (!creating) setMode(next);
                }}
              />
            </fieldset>
          </div>
        )}

        <LaunchRefusal error={formLaunchError}>
          {visibleMode === "existing" ? (
            <ExistingSubshellList
              subshells={available}
              query={query}
              onQueryChange={setQuery}
              loadFailed={subshellsFailed}
              loading={subshellsLoading}
              onPick={(id) => void handlePick(id)}
              busyId={busyId}
            />
          ) : (
            <div className="flex flex-col gap-4">
              <SubshellKindPicker value={kind} onChange={setKind} disabled={creating} />
              {!agentBranch ? (
                <ConnectPanel
                  draft={sshDraft}
                  onDraftChange={setSshDraft}
                  onPendingChange={setCreating}
                  initial={{ node: form.nodeId || undefined }}
                  onLeave={dismiss}
                  onCreated={async (id) => {
                    try {
                      await onAdd(id, "within");
                      onOpenChange(false);
                      reset();
                    } catch (err) {
                      setError(
                        `SSH subshell was created but could not be added (${errMessage(err, "unknown error")}). Add it from the list instead.`,
                      );
                      setForm({ ...form, nodeId: "" });
                      setMode("existing");
                    }
                  }}
                />
              ) : (
                <NewSubshellForm value={form} onChange={setForm} onLeave={dismiss} launchError={displayLaunchError} />
              )}
            </div>
          )}
        </LaunchRefusal>

        {visibleMode === "new" && kind === "agent" && (
          <DialogFooter sticky>
            <Button
              variant="outline"
              onClick={dismiss}
              disabled={creating}
              disabledReason={"Wait for the subshell to start."}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={creating || !canSubmit(form)}
              disabledReason={creating ? "Wait for the subshell to start." : launchDisabledReason(form)}
            >
              {creating ? "Starting…" : "Start subshell"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
