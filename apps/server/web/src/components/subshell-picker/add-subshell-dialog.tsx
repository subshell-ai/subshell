import { Button, errMessage } from "@internal/node-admin";
import { type JSX, useState } from "react";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { sshSessionDraft } from "@/components/connect/ssh-session-draft";
import { DirectionSelect } from "@/components/subshell-picker/direction-select";
import { ExistingSubshellList } from "@/components/subshell-picker/existing-subshell-list";
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
import { Segmented } from "@/components/ui/segmented";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useSubshellsList } from "@/hooks/use-subshells";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import type { SplitDirection } from "@/types/workspace";

/** Which half of the dialog is showing. */
type Mode = "existing" | "new";

/**
 * Adds a subshell to a workspace: an existing one picked from a searchable
 * list, or a brand-new one, with one control deciding where it lands.
 *
 * Both halves live in one dialog because they answer the same question —
 * "what goes in this new pane?" — and the placement applies identically to
 * either answer.
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
  const create = useCreateSubshell();

  const [sshDraft, setSshDraft] = useState(() => sshSessionDraft({ node: initialForm?.nodeId }));
  const [kind, setKind] = useState<SubshellKind>("agent");
  const [mode, setMode] = useState<Mode>("existing");
  const [direction, setDirection] = useState<SplitDirection>("right");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<NewSubshellFormValue>(() => ({ ...emptyNewSubshellForm(), ...initialForm }));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excluded = new Set(excludeSubshellIds);
  const available = (subshells ?? []).filter((s) => !excluded.has(s.id));

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

  /** Adds an existing subshell, closing the dialog on success. */
  async function handlePick(subshellId: string) {
    setError(null);
    setBusyId(subshellId);
    try {
      await onAdd(subshellId, direction);
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
      await onAdd(created.id, direction);
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

  return (
    <Dialog
      open={open}
      // A half-filled launch form is not disposable (ruling 2026-09-30):
      // only a deliberate act closes this - X, Cancel, or a successful add.
      onOpenChange={formDialogOpenChange((next) => {
        if (creating) return;
        onOpenChange(next);
        if (!next) reset();
      })}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? "Add a subshell"}</DialogTitle>
          <DialogDescription>{description ?? "Pick one you already have, or launch a new one."}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <fieldset disabled={creating || busyId !== null}>
            <Segmented
              ariaLabel="What to add"
              options={[
                { value: "existing", label: "Existing subshell" },
                { value: "new", label: "New subshell" },
              ]}
              value={mode}
              onChange={(next) => {
                if (!creating) setMode(next);
              }}
            />
          </fieldset>
          <fieldset disabled={creating || busyId !== null}>
            <DirectionSelect value={direction} onChange={setDirection} />
          </fieldset>
        </div>

        {mode === "existing" ? (
          <ExistingSubshellList
            subshells={available}
            // Keep the two halves coherent: the list shows subshells on the
            // node the New-subshell half would launch onto ("local" until a
            // remote pick is made; an unmade pick — "" — is the local default).
            // Display filtering only: the list is already visibility-filtered
            // server-side and this never substitutes for authz.
            nodeId={kind === "ssh" ? undefined : form.nodeId || "local"}
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
            {kind === "ssh" && open ? (
              <ConnectPanel
                draft={sshDraft}
                onDraftChange={setSshDraft}
                onPendingChange={setCreating}
                initial={{ node: form.nodeId || undefined }}
                onLeave={() => onOpenChange(false)}
                onCreated={async (id) => {
                  try {
                    await onAdd(id, direction);
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
              <NewSubshellForm value={form} onChange={setForm} onLeave={() => onOpenChange(false)} />
            )}
          </div>
        )}

        {error && <p className="text-destructive text-detail">{error}</p>}

        {mode === "new" && kind === "agent" && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={creating || !canSubmit(form)}>
              {creating ? "Starting…" : "Start subshell"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
