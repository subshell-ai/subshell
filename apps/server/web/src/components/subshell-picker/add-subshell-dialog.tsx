import { Button, errMessage } from "@internal/node-admin";
import { type JSX, useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import { LaunchRefusal } from "@/components/launch-error-line";
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
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { displayFieldOwnsRefusal, splitLaunchError } from "@/lib/display-refusal-routing";
import type { SplitDirection } from "@/types/workspace";

/**
 * Launches a new subshell into a workspace: an agent, a plain terminal, or an
 * SSH session. Existing subshells join a workspace by being clicked in the
 * sidebar or dragged onto it, so this dialog only asks what to start.
 *
 * The Split flow opens this same dialog before any workspace exists, seeded
 * from the subshell being split, and adds the launched pane beside it.
 */
export function AddSubshellDialog({
  open,
  onOpenChange,
  initialForm,
  title,
  description,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Seeds the launch form, merged over the empty form — and returned to by
   * `reset()`, so a cancelled launch starts from the same place the dialog
   * opened at. A split passes the current subshell's plugin, node and
   * directory so the form starts as "another one like this".
   */
  initialForm?: Partial<NewSubshellFormValue>;
  /**
   * The dialog's heading. Defaults to "Add a subshell"; a caller that names
   * the flow passes its own word. The button that opens it is icon-only, so
   * this heading is where the word lives.
   */
  title?: string;
  /** The line under the heading. Defaults to the launch description. */
  description?: string;
  /**
   * Adds `subshellId` to the workspace at `direction`. Resolves `false` when
   * the caller showed its own failure and did not add the pane; resolving
   * nothing means the pane was added.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: success carries no value; only a refusal needs a signal
  onAdd: (subshellId: string, direction: SplitDirection) => Promise<boolean | void>;
}): JSX.Element {
  // Placement is this dialog's own decision (the workspace it was opened
  // from, or the split's, or the workspace it just created) — the hook must
  // not open a SECOND workspace around the pane. See `useCreateSubshell`.
  const create = useCreateSubshell({ autoFile: false });

  const [sshDraft, setSshDraft] = useState(() => sshSessionDraft({ node: initialForm?.nodeId }));
  const [kind, setKind] = useState<SubshellKind>("agent");
  const [form, setForm] = useState<NewSubshellFormValue>(() => ({ ...emptyNewSubshellForm(), ...initialForm }));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The subshell exists but never reached the workspace. Re-enabling Start
  // would launch a second one, so the dialog drops to a Close-only state.
  const [createdNotAdded, setCreatedNotAdded] = useState(false);

  /** Resets everything the next open should not inherit. */
  function reset() {
    setSshDraft(sshSessionDraft({ node: initialForm?.nodeId }));
    setKind("agent");
    setForm({ ...emptyNewSubshellForm(), ...initialForm });
    setCreating(false);
    setError(null);
    setCreatedNotAdded(false);
  }

  function dismiss() {
    if (creating) return;
    onOpenChange(false);
    reset();
  }

  /**
   * Creates a subshell and adds it. If the subshell is created but adding it
   * fails, the subshell is left alone rather than deleted — it is still
   * reachable from the subshells page (the create hook invalidated the list,
   * so it is already there), and clicking it there files it the same way.
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
      const added = await onAdd(created.id, "within");
      if (added === false) throw new Error("the workspace refused the pane");
      onOpenChange(false);
      reset();
    } catch (err) {
      setCreatedNotAdded(true);
      setError(
        `The subshell was created but couldn't be added (${errMessage(err, "unknown error")}). Find it in the subshells list and click it to open it in a workspace.`,
      );
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
  const agentBranch = kind !== "ssh";
  const { field: displayLaunchError, form: formLaunchError } = splitLaunchError(
    error,
    displayFieldOwnsRefusal({ mounted: !createdNotAdded && agentBranch, virtualDisplay: form.virtualDisplay }),
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
          <DialogTitle>{title ?? "Add a subshell"}</DialogTitle>
          <DialogDescription>
            {description ?? "Launch an agent, a terminal, or an SSH session in this workspace."}
          </DialogDescription>
        </DialogHeader>

        <LaunchRefusal error={formLaunchError}>
          {!createdNotAdded && (
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
                      const added = await onAdd(id, "within");
                      if (added === false) throw new Error("the workspace refused the pane");
                      onOpenChange(false);
                      reset();
                    } catch (err) {
                      setError(
                        `The SSH subshell was created but couldn't be added (${errMessage(err, "unknown error")}). Find it in the subshells list and click it to open it in a workspace.`,
                      );
                      setCreatedNotAdded(true);
                    }
                  }}
                />
              ) : (
                <NewSubshellForm value={form} onChange={setForm} onLeave={dismiss} launchError={displayLaunchError} />
              )}
            </div>
          )}
        </LaunchRefusal>

        {createdNotAdded ? (
          <DialogFooter sticky>
            <Button variant="outline" onClick={dismiss}>
              Close
            </Button>
          </DialogFooter>
        ) : kind === "agent" ? (
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
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
