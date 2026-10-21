import { ApiError, Button, errMessage, type Node, useNode } from "@internal/node-admin";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { useDeleteNode } from "@/hooks/use-nodes";
import { type FieldProblems, makeForm, useSubmitDisabled, useSubmitDisabledReason } from "@/lib/form";

/** Both node pages use the same fresh count and explicit force confirmation. */
export function DeleteNodeDialog({
  node,
  onClose,
  onDeleted,
}: {
  node: Pick<Node, "id" | "name">;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const detail = useNode(node.id);
  const deletion = useDeleteNode();
  const [error, setError] = useState<string | null>(null);
  const [forceRequired, setForceRequired] = useState(false);
  // Admins retiring another owner's node may not receive a count. Keep the
  // DELETE refusal until a fresh detail read can tell us whether it still applies.
  useEffect(() => {
    if (detail.dataUpdatedAt > 0 && detail.data?.runningSubshells !== undefined) setForceRequired(false);
  }, [detail.dataUpdatedAt, detail.data?.runningSubshells]);
  async function remove(force: boolean) {
    if (deletion.isPending) return;
    setError(null);
    try {
      await deletion.mutateAsync({ id: node.id, force });
      onClose();
      onDeleted?.();
    } catch (err) {
      if (err instanceof ApiError && err.code === "NODE_RUNNING_SUBSHELLS") {
        setForceRequired(true);
        void detail.refetch();
        return;
      }
      setError(errMessage(err, "Couldn't delete this node."));
      if (err instanceof ApiError && err.code === "NODE_ONLINE") void detail.refetch();
    }
  }
  const requiresForce = forceRequired || (detail.data?.runningSubshells ?? 0) > 0;
  const blocked = detail.isPending
    ? "Checking this node’s subshells."
    : detail.isError
      ? "Retry the node check before deleting it."
      : requiresForce && detail.data?.status === "online"
        ? "Take this node offline before force-deleting it, or stop its subshells first."
        : undefined;
  return (
    <Dialog open onOpenChange={(open) => !open && !deletion.isPending && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete this node?</DialogTitle>
          <DialogDescription>This deletes "{node.name}" and revokes its enrollment key.</DialogDescription>
        </DialogHeader>
        {detail.isError && (
          <Button variant="outline" onClick={() => void detail.refetch()}>
            Retry node check
          </Button>
        )}
        {error && <ErrorBanner message={error} />}
        <DeleteNodeForm
          key={`${requiresForce}:${blocked ?? "ready"}`}
          busy={deletion.isPending}
          onDelete={remove}
          requiresForce={requiresForce}
          blocked={blocked}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function DeleteNodeForm({
  busy,
  onDelete,
  requiresForce,
  blocked,
  onClose,
}: {
  busy: boolean;
  onDelete: (force: boolean) => Promise<void>;
  requiresForce: boolean;
  blocked?: string;
  onClose: () => void;
}) {
  const form = makeForm({
    defaultValues: { force: false },
    validator: ({ force }): FieldProblems => {
      if (blocked) return { force: blocked };
      if (requiresForce && !force) return { force: "Confirm force deletion to continue." };
      return {};
    },
    onSubmit: async ({ force }) => {
      if (blocked || (requiresForce && !force) || busy) return;
      await onDelete(requiresForce && force);
    },
  });
  const disabled = useSubmitDisabled(form, busy);
  const disabledReason = useSubmitDisabledReason(form, busy);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {requiresForce && (
        <>
          <p className="text-body text-muted-foreground">
            This node has subshells marked as running. Force deletion leaves those subshells in place and doesn't stop
            processes on the machine. They won't be reachable through this node after deletion.
          </p>
          <form.Field name="force">
            {(field) => (
              <Field className="flex-row items-center">
                <Checkbox id="force-delete-node" checked={field.state.value} onCheckedChange={field.handleChange} />
                <FieldLabel htmlFor="force-delete-node">Force delete this node</FieldLabel>
              </Field>
            )}
          </form.Field>
        </>
      )}
      {blocked && <p className="text-body text-warning">{blocked}</p>}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={busy}
          disabledReason="Wait for node deletion to finish."
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={disabled} disabledReason={disabledReason}>
          {busy ? "Deleting…" : "Delete node"}
        </Button>
      </DialogFooter>
    </form>
  );
}
