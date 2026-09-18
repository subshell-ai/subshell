import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NodeKeySetup } from "@/components/nodes/node-key-setup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCreateSetupKey, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { errMessage } from "@/lib/api";
import type { CreatedSetupKey } from "@/types/node";

/**
 * "Add node": ONE screen — the address, the mint press, and how to hand the key to
 * the machine (spec 2026-08-31 §5.1/§9).
 *
 * **The two-step is gone** (operator's call, 2026-09-18): the dialog used to open on
 * a "Add a node" screen whose whole content was one button, and clicking it swapped
 * in the instructions. Now opening the trigger lands directly on the instructions —
 * titled "Install Subshell Client" — and the mint is a **Generate setup key** press
 * between the address picker and the path switch. Until that press the key does not
 * exist, and the screen says so rather than leaving a hole: the app path's key row
 * reads "Generate setup key first" and the terminal one-liner shows with
 * `<generate setup key first>` in its token slot, copy disabled (the command's shape
 * is the instruction and is on screen from the start; the fake token is unmistakable
 * and nothing runs until the press). The generate slot between the picker and the
 * switch carries the button and its failure line and NOTHING ELSE (operator's call,
 * 2026-09-18) — the old first screen's descriptive sentences are gone, and the amber
 * no-binary verdict now sits in the terminal panel beside the command it refuses,
 * which keeps the old point (do not make the operator mint a key to discover the
 * one-liner cannot work) while putting the refusal where the command is read.
 *
 * **It asks no name, and never did what it looked like it did.** This dialog used to
 * open with a "Node name" field whose text became only the setup key's `label`: the
 * one-liner ran `subshell setup` with no name, so the node was named by its own
 * hostname whatever was typed here. The field is gone with the 2026-09-17 revamp, and
 * the name is asked where it can actually be answered — on the machine, by `setup`, or
 * by `--name` for a script, or by the Subshell Client enroll form.
 *
 * **The instructions themselves live in `node-key-setup.tsx`**, shared with the Setup
 * keys card's Setup dialog. This file owns only what is specific to minting now: the
 * generate press, its errors, and the watcher that says when the machine has arrived.
 *
 * **The key is no longer a once-only secret.** The Setup keys card on this same page
 * lists it until it is spent or expires, which is why closing this dialog mid-copy
 * stopped being a re-mint — and why that card can offer the same instructions later.
 *
 * While the dialog is open the page polls the node list every 3 s, and the "enrolled"
 * line appears when the machine shows up. Nothing marks the waiting itself: the open
 * dialog IS the waiting (operator's call, 2026-09-18, same day the key-lifetime
 * paragraph went — its facts live on the Setup keys card).
 */
export function AddNodeDialog({
  open,
  onOpenChange,
  nodeCount,
}: {
  /** Whether the dialog is shown (drives the parent's polling too) */
  open: boolean;
  /** Open/close from inside (Done/overlay) */
  onOpenChange: (open: boolean) => void;
  /** Current visible-node count — its rise over the creation-time baseline means "enrolled" */
  nodeCount: number;
}) {
  const create = useCreateSetupKey();
  // refetch-on-open: the shared query is 30 s fresh, but the warning's whole
  // job is tracking a fact the OPERATOR changes (publishing artifacts) and
  // then immediately re-checking by reopening this dialog — a stale verdict
  // here is the bug this field exists to prevent, in the other direction.
  // It refetches for the panels too, through the same query: `NodeKeySetup`
  // reads the verdict off this hook, so one fetch feeds both.
  const { refetch } = usePublicSettings();
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const [formError, setFormError] = useState<string | null>(null);
  // The minted key: set after a successful generate, cleared on close. Null is
  // the screen's initial state, not a loading state — nothing is spent yet.
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
        {/* One header, intentionally description-less (operator's call, 2026-09-18):
            the naming fact rides the mint no more (the machine answers) and
            single-use/24 h is said once on the Setup keys card. Base UI omits
            `aria-describedby` silently where a description is absent — unlike Radix,
            there is no console warning to route around. The e2e suite keys on this
            heading (12-nodes.spec.ts), so a retitle moves both. */}
        <DialogHeader>
          <DialogTitle>Install Subshell Client</DialogTitle>
        </DialogHeader>
        <NodeKeySetup
          keyText={created?.key ?? null}
          generate={
            created === null ? (
              <div className="space-y-2">
                {formError && <p className="text-destructive text-detail">{formError}</p>}
                <Button onClick={() => void mint()} disabled={create.isPending}>
                  {create.isPending ? "Generating…" : "Generate setup key"}
                </Button>
              </div>
            ) : null
          }
        />
        {/* No key-lifetime paragraph and no waiting line (operator's call,
            2026-09-18): single-use/24 h is the card's business, said once on
            the Setup keys list that IS the "you can come back to it" answer,
            and a dialog that polls does not need a sentence announcing that
            it is waiting. Both asserted as absences in the dialog's tests. */}
        {enrolled &&
          // The guidance used to end here, at the moment the operator most
          // needs the next step (spec 2026-09-15 §5.4). The node's own page
          // is where detection has run, so it is the page that says what
          // this machine can actually launch.
          (arrivedNode ? (
            <p className="text-sm text-success">
              {arrivedNode.name} enrolled.{" "}
              <Link to="/nodes/$id" params={{ id: arrivedNode.id }} className="underline" onClick={close}>
                Open its page
              </Link>{" "}
              to see what it can launch.
            </p>
          ) : (
            <p className="text-sm text-success">Node enrolled. Close this dialog to see it in the list.</p>
          ))}
        <DialogFooter>
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
