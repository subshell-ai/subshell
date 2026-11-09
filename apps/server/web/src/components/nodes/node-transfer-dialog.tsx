import { Button, errMessage } from "@internal/node-admin";
import { useId, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { useTransferNode } from "@/hooks/use-nodes";
import { useSharableUsers } from "@/hooks/use-subshell-shares";
import { useCurrentUser } from "@/lib/auth";

/**
 * The ownership handover dialog (spec 2026-11-07) — the only human door to
 * `POST /api/nodes/:id/transfer`, opened solely from the node page where
 * `Node.canTransfer` is true (the owner of an enrolled machine; never
 * `local`, never a manage grantee, never an admin). A direct handover: the
 * recipient does not accept, the act lands the moment Save does, and the
 * machine notices nothing. The consequences therefore belong in this dialog,
 * at the press, not in a doc somewhere: what survives (the link, running
 * subshells, the other shares) and what does not (unused recovery keys).
 *
 * "Keep managing it yourself" rides on by default: most owners handing a
 * machine to a teammate mean to keep operating it, and the manage share is
 * exactly that. Uncheck it and the handover is clean, no grant left behind.
 */
export function NodeTransferDialog({
  nodeId,
  nodeName,
  open,
  onOpenChange,
  onDone,
}: {
  /** The node being handed over ("local" never opens this dialog) */
  nodeId: string;
  /** Its display name, for the body copy */
  nodeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs after a successful handover (the page leaves; this machine is no longer yours) */
  onDone: () => void;
}) {
  const roster = useSharableUsers(open);
  const me = useCurrentUser();
  const transfer = useTransferNode(nodeId);
  const [pickId, setPickId] = useState("");
  const [retain, setRetain] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pickerId = useId();
  const busy = transfer.isPending;
  const loading = roster.isPending || me.isPending;
  // A dead read is its own answer, never the picker's "no matching people":
  // that text would tell the owner the instance holds nobody (sharing-core
  // idiom: ErrorBanner + Retry over the failed read).
  const loadFailed = roster.isError || me.isError;
  // ONE expression names why the button is dead and the handler holds the
  // line, so the two can never disagree (form-substrate discipline).
  const submitBlocker = busy
    ? "The transfer is in flight."
    : loading
      ? "Wait for the people list to load."
      : roster.isError
        ? "Reload the people list first."
        : me.isError
          ? "Reload the page to confirm your session first."
          : !pickId
            ? "Choose who takes it over first."
            : undefined;
  // Yourself is never the answer to "who takes it over"; a disabled account
  // is refused by the server, and the picker shows the account's own list.
  const options = (roster.data ?? [])
    .filter((user) => user.id !== me.data?.id)
    .map((user) => ({ value: user.id, label: user.email, searchText: user.name }));

  function handleClose(next: boolean) {
    if (!next && busy) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function submit() {
    if (submitBlocker) return;
    setError(null);
    try {
      await transfer.mutateAsync({ toUserId: pickId, retainAccessAsManager: retain });
      setPickId("");
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(errMessage(err, "Couldn't transfer this node."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Transfer this node?</DialogTitle>
          <DialogDescription>
            This hands "{nodeName}" to another account. Its connection, its running subshells, and its other shares keep
            working; setup keys minted for it but never used stop working.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-detail text-muted-foreground">Loading people…</p>
        ) : loadFailed ? (
          <ErrorBanner
            message={
              roster.isError ? "Couldn't load the people list. Try again." : "Couldn't confirm your session. Try again."
            }
            action={
              <Button
                variant="link"
                onClick={() => {
                  void roster.refetch();
                  void me.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-1">
            <label htmlFor={pickerId} className="sr-only">
              New owner
            </label>
            <SearchableSelect
              id={pickerId}
              value={pickId}
              onValueChange={setPickId}
              placeholder="Search people…"
              options={options}
              emptyText="No matching people to hand it to."
            />
            {/* A required picker with no caret-leave moment wears the gold
                sentence at rest once its options settle (ruling 2026-09-30):
                the disabled button's tooltip is unreachable for touch. */}
            {!busy && !pickId && <p className="text-detail text-warning">Choose who takes it over first.</p>}
          </div>
        )}

        <Field className="flex-row items-center">
          <Checkbox id="transfer-keep-manage" checked={retain} onCheckedChange={(next) => setRetain(next === true)} />
          <FieldLabel htmlFor="transfer-keep-manage">Keep managing it yourself</FieldLabel>
        </Field>
        <p className="text-detail text-muted-foreground">
          {retain
            ? "You stay a Manage grantee: its settings, shares, and service stay yours to drive, except handing it to someone else, deleting or re-registering it, or moving files through it."
            : "You'll keep nothing: the moment it lands, this node is out of your hands."}
        </p>

        {error && <ErrorBanner message={error} />}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            disabledReason="The transfer is in flight."
            onClick={() => handleClose(false)}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitBlocker !== undefined} disabledReason={submitBlocker}>
            {busy ? "Transferring…" : "Transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
