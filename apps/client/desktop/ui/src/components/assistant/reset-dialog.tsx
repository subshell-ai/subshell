/**
 * Reset everything — the one irreversible act in this app, as a DIALOG
 * (operator ruling 2026-09-22: it should be a dialog with the confirmation,
 * not a frame-replacing screen). The rail's danger item opens it over
 * whatever section stands; nothing about the section changes, and when the
 * chain ends the dialog closes itself and that section carries the outcome,
 * because the press happened there.
 *
 * What the old room ruled, the modal rules harder: "no navigation beside a
 * chain that is deleting this machine's node" — a modal IS that, and while
 * the chain runs Escape and the backdrop are inert and Cancel is disabled,
 * so the one running thing cannot be walked away from. What stays verbatim
 * from the screen is the CONSENT, which is the whole reason the confirmation
 * exists: the page supplies a HOSTNAME, never a path; the delete plan is
 * armed from the node's own `status --json` the moment the dialog opens
 * (`nodeArmReset`), and `false` — an un-enrolled machine — says so instead
 * of offering a button that would refuse. The disclosures are spec
 * 2026-09-11 § 5.4, still on the confirmation rather than in a help page,
 * because this is the last moment anyone reads them.
 */
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionRunner } from "@/hooks/use-action-runner";
import { finished } from "@/lib/actions";
import { nodeArmReset, nodeReset, type Probe } from "@/lib/ipc";

/** What a reset does NOT reach (spec 2026-09-11 § 5.4). */
const DISCLOSURES: readonly string[] = [
  "The control plane keeps a node row for this machine. It will show as permanently offline, and its owner has to delete it there.",
  "Any subshells that ran here are gone, and so are their pane logs.",
  "A Subshell Server on this same machine is not touched. Reset it from its own app.",
  "The installed subshell binary stays.",
  "This app's saved control planes are cleared too, and it starts at the beginning again.",
  "Everything above is permanent.",
];

export function ResetDialog(props: {
  probe: Probe | undefined;
  runner: ActionRunner;
  busy: boolean;
  onClose: () => void;
}): ReactElement {
  const { probe, runner, busy, onClose } = props;
  /** null while arming; true once a plan is staged; false on a machine with nothing to reset. */
  const [armed, setArmed] = useState<boolean | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let live = true;
    void nodeArmReset()
      .then((ok) => {
        if (live) setArmed(ok);
      })
      // A refused arm is an un-armed dialog, which renders the same refusal
      // a failed parse does: either way there is nothing staged to run.
      .catch(() => {
        if (live) setArmed(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // The chain's end closes the dialog, success or refusal — the submit-closes
  // grammar of every other save, and the outcome's words belong to the screen
  // the press happened on, which the modal has just uncovered. The true→false
  // EDGE is what matters, so a parent re-render mid-chain cannot fire it.
  const wasBusy = useRef(false);
  useEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    if (was && !busy) onClose();
  }, [busy, onClose]);

  /** The name the Rust side will compare against — shown so the box can be
   *  typed without guessing. The gate is deliberate consent, not a memory test. */
  const host = probe?.hostname ?? "";
  /** Where this node reports — the plane that keeps the orphaned row. */
  const reportsTo = probe?.status?.serverUrl ?? null;
  const paths = [probe?.paths?.dataDir, probe?.paths?.configFile].filter((p): p is string => Boolean(p));

  const press = () => {
    if (busy || typed.trim() === "") return;
    // A hostname crosses the boundary, and NOTHING else — no path, ever.
    runner.run(async () => finished(await nodeReset({ typed: typed.trim() })));
  };

  return (
    <Dialog
      title="Reset everything?"
      // While the chain runs the dismissal is inert: a running reset keeps
      // its old room's one rule, that nothing ends it but its own end.
      onClose={busy ? () => undefined : onClose}
    >
      {armed === false ? (
        // The operator's exact words (ruling batch, 2026-09-22, screenshot
        // 59): the "nothing has been changed" tail is deleted; the sentence
        // says what the machine is not and stops.
        <>
          <p className="text-muted-foreground text-sm leading-relaxed">
            This machine is not registered with a control plane.
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : armed === null ? (
        <p className="text-muted-foreground text-detail">Checking what this machine would delete…</p>
      ) : (
        <>
          {paths.length > 0 && (
            <div>
              <p className="text-muted-foreground text-detail">This deletes</p>
              <ul className="mt-1 flex flex-col gap-1">
                {paths.map((p) => (
                  <li key={p} className="break-all font-mono text-detail">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="mt-4 flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
            {DISCLOSURES.map((line) => (
              <li key={line} className="flex items-start gap-2 text-muted-foreground text-detail leading-relaxed">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              press();
            }}
          >
            <Label htmlFor="reset-hostname" className="text-muted-foreground text-detail">
              {host ? (
                <>
                  Type <span className="font-mono">{host}</span> to confirm
                </>
              ) : (
                "Type this machine's name to confirm"
              )}
            </Label>
            <Input
              id="reset-hostname"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              disabled={busy}
            />
            {reportsTo && (
              <p className="text-muted-foreground text-detail">
                This node reports to <span className="break-all font-mono">{reportsTo}</span>.
              </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                className="min-w-[120px]"
                disabled={busy || typed.trim() === ""}
              >
                {busy ? "Resetting…" : "Reset Everything"}
              </Button>
            </div>
          </form>
        </>
      )}
    </Dialog>
  );
}
