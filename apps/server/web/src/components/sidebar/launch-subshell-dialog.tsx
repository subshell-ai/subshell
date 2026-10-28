import { apiPost, Button } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useRef, useState } from "react";
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
import { invalidateWorkspaceMembership } from "@/hooks/use-workspaces";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { currentWorkspaceId } from "@/lib/current-workspace";
import { displayFieldOwnsRefusal, splitLaunchError } from "@/lib/display-refusal-routing";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { sshConnectSearch } from "@/lib/ssh-connect-search";
import { fileLaunchedPane } from "@/lib/workspace-filing";
import { armPaneFocusOnArrive } from "@/lib/workspace-focus";

/**
 * The rail's quick-launch dialog (spec 2026-09-03 sidebar-quickadd §4a), and
 * since 2026-09-11 the ONLY new-subshell surface: `/new` used to render a
 * second copy of this form as a full-page card and now simply raises this
 * dialog over the list. The shared `NewSubshellForm` owns the fields,
 * `useCreateSubshell` owns the POST, and a success lands on the workspace the
 * pane was filed into (the plain subshell page only when filing failed).
 */
export function LaunchSubshellDialog({
  open,
  onOpenChange,
  initialSsh,
  initialNodeId,
}: {
  initialNodeId?: string;
  initialSsh?: ReturnType<typeof sshConnectSearch>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [sshPending, setSshPending] = useState(false);
  const [sshDraft, setSshDraft] = useState(() => sshSessionDraft(initialSsh));
  const [kind, setKind] = useState<SubshellKind>(initialSsh ? "ssh" : "agent");
  const contentRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useCreateSubshell();
  const [form, setForm] = useState<NewSubshellFormValue>(() => ({
    ...emptyNewSubshellForm(),
    ...(initialNodeId ? { nodeId: initialNodeId } : {}),
  }));
  const [error, setError] = useState<string | null>(null);
  // A display refusal reads as the checkbox's own result, so the field
  // renders it; everything else keeps the form-level line.

  function reset() {
    setSshDraft(sshSessionDraft(initialSsh));
    setForm(emptyNewSubshellForm());
    setError(null);
    setKind("agent");
  }

  function dismiss() {
    if (sshPending || create.isPending) return;
    onOpenChange(false);
    reset();
  }

  async function submit() {
    setError(null);
    try {
      const created = await create.mutateAsync(form);
      // A prompt that did not land announces itself through the hook's
      // toast, across this navigation (spec 2026-09-28); the launch itself is
      // a success. Where the success LANDS depends on where the press came
      // from: a launch raised over a workspace page was filed there by the
      // create (spec 2026-10-17), so stay on the workspace and let the dock
      // reconcile the new tab; anywhere else the subshell page is the
      // destination it has always been.
      // Every launch files itself (spec 2026-10-17): `created.workspaceId`
      // is the workspace opened around the pane when none was on screen. If
      // that filing call failed, fall through to the ordinary subshell page
      // — the pane is running, and clicking it later files it the same way.
      const landing = created.workspaceId ?? currentWorkspaceId();
      onOpenChange(false);
      reset();
      if (landing) void navigate({ to: "/workspaces/$id", params: { id: landing } });
      else void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch (err) {
      // Node-aware copy: an offline remote pick answers 409 NODE_OFFLINE and
      // gets the actionable line (same helper as /new and the add-dialog).
      setError(createSubshellErrorMessage(err, "Failed to create subshell"));
    }
  }

  // ONE variable decides "the agent branch is on screen": the split below and the
  // JSX that mounts `NewSubshellForm` both read it, because written twice the two
  // can drift, and the drift silences the refusal. The field owns a display
  // refusal while that control is on screen and switched on; otherwise the form
  // line takes it back, so it is never both invisible and orphaned.
  const agentBranch = !(kind === "ssh" && open);
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
        if (sshPending || create.isPending) return;
        if (next) onOpenChange(true);
        else dismiss();
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
        <LaunchRefusal error={formLaunchError}>
          {!agentBranch ? (
            <ConnectPanel
              draft={sshDraft}
              onDraftChange={setSshDraft}
              onPendingChange={setSshPending}
              initial={initialSsh}
              onLeave={dismiss}
              onCreated={async (id) => {
                onOpenChange(false);
                reset();
                // The SSH create rides `/api/ssh/launch`, which knows nothing of
                // workspaces — so the filing this dialog's AGENT path gets from
                // the create server-side is this half's to do (spec
                // 2026-10-17): onto the workspace on screen when there is one
                // (the idempotent pane add, and the same arming), else the
                // shared no-screen ladder. The two invalidations are what
                // `useCreateSubshell` performs after its own create: the rail's
                // tree and the pane rows wake from the caches, not a reload.
                const onto = currentWorkspaceId();
                let filed: string | null = null;
                if (onto && (await apiPost(`/api/workspaces/${onto}/panes`, { subshellId: id }).catch(() => null))) {
                  armPaneFocusOnArrive(id);
                  filed = onto;
                } else {
                  filed = await fileLaunchedPane(id);
                }
                void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
                void invalidateWorkspaceMembership(queryClient);
                if (filed) void navigate({ to: "/workspaces/$id", params: { id: filed } });
                else void navigate({ to: "/subshells/$id", params: { id } });
              }}
            />
          ) : (
            <>
              <NewSubshellForm
                skipPriorLaunch={initialNodeId !== undefined}
                value={form}
                onChange={setForm}
                onLeave={dismiss}
                launchError={displayLaunchError}
              />
              <DialogFooter sticky>
                <Button
                  variant="outline"
                  onClick={dismiss}
                  disabled={create.isPending}
                  disabledReason="Wait for the subshell to start."
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void submit()}
                  disabled={create.isPending || !canSubmit(form)}
                  disabledReason={create.isPending ? "Wait for the subshell to start." : launchDisabledReason(form)}
                >
                  {create.isPending ? "Starting…" : "Start subshell"}
                </Button>
              </DialogFooter>
            </>
          )}
        </LaunchRefusal>
      </DialogContent>
    </Dialog>
  );
}
