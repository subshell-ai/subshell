/**
 * Which control plane THIS MACHINE'S NODE reports to — and the one gesture
 * that changes it without re-enrolling.
 *
 * Deliberately not part of `plane-card.tsx`, whose two doors both mean "show
 * me a plane". This is a third thing: it rewrites `serverUrl` in the agent's
 * `config.json`, which decides where subshells started here appear. Folding it
 * into the Open button would make "look at a plane" and "move this machine to
 * a plane" one click, which is the conflation the app's two windows exist to
 * undo — and it is the same reason the field is not the enrolment form's
 * either, since that one spends a setup key.
 *
 * Drawn only for a machine that IS a node: there is nothing to repoint
 * otherwise, and an un-enrolled client showing a "repoint" control would be
 * offering to change a value that does not exist.
 */
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeSettings, Probe } from "@/lib/ipc";
import { planeCoherence } from "@/lib/plane-coherence";
import { isLoopback } from "@/lib/steps";

export function NodePlaneCard(props: {
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  busy: boolean;
  /** Rewrite the node's `serverUrl`. Non-destructive — no confirmation phase. */
  onRepoint: (server: string) => void;
}) {
  const { probe, settings, busy, onRepoint } = props;
  const nodeServerUrl = probe?.status?.serverUrl ?? null;
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const divergence = planeCoherence(settings?.planeUrl, nodeServerUrl);

  // Not a node: nothing to repoint, and nothing to be incoherent with.
  if (!probe?.status?.nodeId || nodeServerUrl === null) return null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        {/*
         * The enroll-time loopback trap, at rest rather than at enrolment. A
         * node pointed at `localhost` dials a control plane on ITS OWN
         * machine: correct when the plane runs here, wrong whenever the
         * address was copied out of a browser on another box — and silent
         * either way, because the node comes up "online" against nothing. It
         * lives on this card because this is where the address it describes
         * now lives, and because this is the card that can fix it.
         */}
        {isLoopback(nodeServerUrl) && (
          <p role="status" aria-label="Loopback control plane" className="flex items-start gap-2 text-xs">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span className="text-muted-foreground">
              This is a loopback address, so this node looks for a control plane on this machine. That is right if the
              server runs here, and wrong if the address came from a browser somewhere else.
            </span>
          </p>
        )}

        {divergence !== null && (
          // A labelled `status` region: the drift is worth announcing, and the
          // test scopes its query to it rather than to the card.
          <div
            role="status"
            aria-label="Control plane mismatch"
            className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          >
            <p className="flex items-start gap-2 text-xs">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>{divergence.message}</span>
            </p>
            {/*
             * The condition this app CANNOT check, so it has to be stated. A
             * repoint keeps the node id and node key, so it works only when
             * the two addresses are one plane under two names — the common
             * case (loopback vs a LAN name), and the reason this exists. On a
             * genuinely different plane, `/ws/node` refuses the socket 401
             * because that plane holds no key bound to this node row, and the
             * node simply goes offline with the reason only in its own log.
             */}
            <p className="text-muted-foreground text-xs">
              Repointing keeps this node's identity, so it works when both are the same control plane under two names. A
              different control plane holds no key for this node and will refuse it. The node would go offline, and
              joining that one means enrolling with a setup key from it.
            </p>
            {/*
             * Said here as well as in the edit form, because this is the path
             * where the omission actively misleads: the button rewrites
             * `config.json`, and this notice is computed FROM that file, so it
             * disappears on the next probe while the running daemon is still
             * attached to the old plane. Subshells started in between keep
             * appearing there with nothing on screen to explain it.
             */}
            <p className="text-muted-foreground text-xs">
              This notice clears as soon as the file changes, but the running agent keeps using the old address until it
              restarts. Restart it below to finish the move.
            </p>
            <div>
              {/*
               * The fix in the direction the user is looking: they are in an
               * app pointed at one plane, so "make the node agree" is the
               * likelier intent than "move the app". Moving the app the other
               * way is what Plane card's own Change button already does. Still
               * one click, because it is reversible — repoint back.
               */}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  onRepoint(divergence.planeUrl);
                }}
              >
                Use {divergence.planeUrl} for this node
              </Button>
            </div>
          </div>
        )}

        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              // Left OPEN on submit, unlike the enrolment form: the CLI's own
              // refusal is the answer to a bad address, and closing the field
              // would make the user retype the whole URL to fix a character.
              onRepoint(typed);
            }}
          >
            <Label htmlFor="node-server-url" className="text-xs">
              Control plane this node reports to
            </Label>
            <p className="text-muted-foreground text-xs">
              Keeps this node's identity, and no setup key is spent, so this works when the new address is the same
              control plane under another name. A different control plane holds no key for this node and will refuse it.
              The agent reads its configuration at start, so restart it afterwards to apply, and this app's own
              control-plane window moves to the new address too.
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="node-server-url"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="https://subshell.example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
              />
              <Button type="submit" size="sm" disabled={busy || typed.trim() === ""}>
                <ArrowRight aria-hidden />
                Repoint
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setTyped("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">This node reports to</p>
              <p className="mt-0.5 truncate font-mono text-xs">{nodeServerUrl}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                // Seeded with the current address: a repoint is usually an
                // edit of this one, most often a host or a port.
                setTyped(nodeServerUrl);
                setEditing(true);
              }}
            >
              Repoint this node…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
