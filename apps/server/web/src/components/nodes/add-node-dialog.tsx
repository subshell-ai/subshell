import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NodeKeySetup, useSetupKeyVerdict } from "@/components/nodes/node-key-setup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateSetupKey, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { errMessage } from "@/lib/api";
import type { CreatedSetupKey } from "@/types/node";

/**
 * "Add node": mint a single-use setup key (spec 2026-08-31 §5.1/§9), then hand it to
 * the machine.
 *
 * **It asks no name, and never did what it looked like it did.** This dialog used to
 * open with a "Node name" field whose text became only the setup key's `label`: the
 * one-liner ran `subshell setup` with no name, so the node was named by its own
 * hostname whatever was typed here. The field is gone with the 2026-09-17 revamp, and
 * the name is asked where it can actually be answered — on the machine, by `setup`, or
 * by `--name` for a script, or by the Subshell Client enroll form. What the mint does
 * now is spend a key, and the one press that does it is the whole first step.
 *
 * **The second step lives in `node-key-setup.tsx`**, shared with the Setup keys card's
 * Setup dialog: which address the node dials, and the Terminal | Desktop App paths.
 * This file owns only what is specific to a key that was JUST minted — the create
 * press, and the watcher that says when the machine has arrived.
 *
 * **The key is no longer a once-only secret.** The Setup keys card on this same page
 * lists it until it is spent or expires, which is why closing this dialog mid-copy
 * stopped being a re-mint — and why that card can offer the same instructions later.
 *
 * While the dialog is open the page polls the node list every 3 s, and the waiting hint
 * flips to "enrolled" when the machine shows up.
 */
export function AddNodeDialog({
  open,
  onOpenChange,
  nodeCount,
}: {
  /** Whether the dialog is shown (drives the parent's polling too) */
  open: boolean;
  /** Open/close from inside (Cancel/Done/overlay) */
  onOpenChange: (open: boolean) => void;
  /** Current visible-node count — its rise over the creation-time baseline means "enrolled" */
  nodeCount: number;
}) {
  const create = useCreateSetupKey();
  const { missingNote, firstRunNote } = useSetupKeyVerdict();
  // refetch-on-open: the shared query is 30 s fresh, but the warning's whole
  // job is tracking a fact the OPERATOR changes (publishing artifacts) and
  // then immediately re-checking by reopening this dialog — a stale verdict
  // here is the bug this field exists to prevent, in the other direction.
  // It refetches for the reveal too, through the same query: `NodeKeySetup`
  // reads the verdict off this hook, so one fetch feeds both.
  const { refetch } = usePublicSettings();
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const [formError, setFormError] = useState<string | null>(null);
  // The reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSetupKey | null>(null);
  const [baselineCount, setBaselineCount] = useState<number | null>(null);
  // WHICH machine arrived, not just that one did. The parent's count answers
  // "something enrolled"; only the ids answer "this is yours", and a
  // concurrent enrollment (another operator, another key) would otherwise
  // hand this one a link to a stranger's node page. Read from the SAME query
  // the parent polls, so the two never disagree and no second request is made.
  const { data: nodeList } = useNodes();
  const [baselineIds, setBaselineIds] = useState<string[] | null>(null);

  function close() {
    onOpenChange(false);
    setCreated(null);
    setFormError(null);
    setBaselineCount(null);
    setBaselineIds(null);
    // Clear the mutation too — a failed create would otherwise flash its error
    // through the fresh dialog on the next open (before the first press).
    create.reset();
  }

  async function mint() {
    setFormError(null);
    try {
      setCreated(await create.mutateAsync());
      setBaselineCount(nodeCount);
      // A list that has not loaded yet leaves this null, which is a refusal to
      // identify the arrival rather than an empty baseline — with `[]` every
      // node already enrolled would read as "just arrived".
      setBaselineIds(nodeList?.nodes ? nodeList.nodes.map((n) => n.id) : null);
    } catch (err) {
      setFormError(errMessage(err, "Something went wrong. No key was created."));
    }
  }

  const enrolled = created !== null && baselineCount !== null && nodeCount > baselineCount;
  // Exactly one new id, or nothing: two machines enrolling while this dialog
  // waits makes "yours" a guess, and a guess here navigates someone to a node
  // they do not own. The generic line is still true in that case.
  const arrived = enrolled && baselineIds ? (nodeList?.nodes ?? []).filter((n) => !baselineIds.includes(n.id)) : [];
  const arrivedNode = arrived.length === 1 ? arrived[0] : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Set up the new machine</DialogTitle>
              <DialogDescription>
                It will ask what to call itself — the name is chosen there, on the machine, not here.
              </DialogDescription>
            </DialogHeader>
            <NodeKeySetup keyText={created.key} />
            <p className="text-detail text-muted-foreground">
              Single-use, and it expires in 24 h. Until then it stays readable on the Setup keys list below, so closing
              this dialog costs nothing.
            </p>
            {enrolled ? (
              // The guidance used to end here, at the moment the operator most
              // needs the next step (spec 2026-09-15 §5.4). The node's own page
              // is where detection has run, so it is the page that says what
              // this machine can actually launch.
              arrivedNode ? (
                <p className="text-sm text-success">
                  {arrivedNode.name} enrolled.{" "}
                  <Link to="/nodes/$id" params={{ id: arrivedNode.id }} className="underline" onClick={close}>
                    Open its page
                  </Link>{" "}
                  to see what it can launch.
                </p>
              ) : (
                <p className="text-sm text-success">Node enrolled. Close this dialog to see it in the list.</p>
              )
            ) : (
              <p className="text-muted-foreground text-sm">Waiting for enrollment. Run it on that machine.</p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mint();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a node</DialogTitle>
              <DialogDescription>
                This creates a single-use setup key. The machine names itself when it enrolls — nothing to fill in here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              {formError && <p className="text-destructive text-detail">{formError}</p>}
              {/* The verdict needs no key — do not make the operator mint
                  (and burn) one to discover the one-liner cannot work. The two
                  notes are about the TERMINAL path's download, so they say so. */}
              {missingNote}
              {firstRunNote}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create setup key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
