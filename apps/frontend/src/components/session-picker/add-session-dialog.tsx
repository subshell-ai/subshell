import { type JSX, useState } from "react";
import { DirectionSelect } from "@/components/session-picker/direction-select";
import { ExistingSessionList } from "@/components/session-picker/existing-session-list";
import {
  canSubmit,
  emptyNewSessionForm,
  NewSessionForm,
  type NewSessionFormValue,
} from "@/components/session-picker/new-session-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useCreateSession } from "@/hooks/use-create-session";
import { useSessionsList } from "@/hooks/use-sessions";
import { errMessage } from "@/lib/api";
import type { SplitDirection, WorkspacePaneRow } from "@/types/workspace";

/** Which half of the dialog is showing. */
type Mode = "existing" | "new";

/**
 * Adds a session to a workspace: an existing one picked from a searchable
 * list, or a brand-new one, with one control deciding where it lands.
 *
 * Both halves live in one dialog because they answer the same question —
 * "what goes in this new pane?" — and the placement applies identically to
 * either answer.
 */
export function AddSessionDialog({
  open,
  onOpenChange,
  existing,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Panes already on this workspace; their sessions are excluded from the list. */
  existing: WorkspacePaneRow[];
  /** Adds `sessionId` to the workspace at `direction`. */
  onAdd: (sessionId: string, direction: SplitDirection) => Promise<void>;
}): JSX.Element {
  const { data: sessions, isError: sessionsFailed, isLoading: sessionsLoading } = useSessionsList();
  const create = useCreateSession();

  const [mode, setMode] = useState<Mode>("existing");
  const [direction, setDirection] = useState<SplitDirection>("right");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<NewSessionFormValue>(emptyNewSessionForm());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attached = new Set(existing.map((p) => p.sessionId));
  const available = (sessions ?? []).filter((s) => !attached.has(s.id));

  /** Resets everything the next open should not inherit. */
  function reset() {
    setMode("existing");
    setQuery("");
    setForm(emptyNewSessionForm());
    setBusyId(null);
    setCreating(false);
    setError(null);
  }

  /** Adds an existing session, closing the dialog on success. */
  async function handlePick(sessionId: string) {
    setError(null);
    setBusyId(sessionId);
    try {
      await onAdd(sessionId, direction);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(errMessage(err, "Failed to add session"));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Creates a session and adds it. If the session is created but adding it
   * fails, the session is left alone rather than deleted — it is still
   * reachable from the sessions page (the create hook invalidated the list,
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
      setError(errMessage(err, "Failed to create session"));
      setCreating(false);
      return;
    }

    try {
      await onAdd(created.id, direction);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(
        `Session was created but could not be added (${errMessage(err, "unknown error")}). Add it from the list instead.`,
      );
      setMode("existing");
    } finally {
      setCreating(false);
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a session</DialogTitle>
          <DialogDescription>Pick one you already have, or launch a new one.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            ariaLabel="What to add"
            options={[
              { value: "existing", label: "Existing session" },
              { value: "new", label: "New session" },
            ]}
            value={mode}
            onChange={setMode}
          />
          <DirectionSelect value={direction} onChange={setDirection} />
        </div>

        {mode === "existing" ? (
          <ExistingSessionList
            sessions={available}
            query={query}
            onQueryChange={setQuery}
            loadFailed={sessionsFailed}
            loading={sessionsLoading}
            onPick={(id) => void handlePick(id)}
            busyId={busyId}
          />
        ) : (
          <NewSessionForm value={form} onChange={setForm} />
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}

        {mode === "new" && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={creating || !canSubmit(form)}>
              {creating ? "Starting…" : "Start session"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
