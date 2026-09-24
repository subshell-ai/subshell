import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyableValue,
  confirmAction,
  errMessage,
  Label,
  type SetupKeyRow,
  Switch,
} from "@internal/node-admin";
import { useState } from "react";
import { NodeKeySetup } from "@/components/nodes/node-key-setup";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type SetupKeyOwnerFields, useAllSetupKeys, useDeleteSetupKey, useSetupKeys } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";

/** A listed row: the owner-scoped shape, plus the creator's label on the admin read. */
type CardKeyRow = SetupKeyRow & Partial<SetupKeyOwnerFields>;

/**
 * The instructions for ONE key this card already lists.
 *
 * Mounted only while open, so the address pick and the path switch start fresh each
 * time rather than remembering the last machine's choices.
 */
function KeySetupDialog({ keyText, onClose }: { keyText: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up a machine with this key</DialogTitle>
          <DialogDescription>
            The key is listed here until it is used, so these steps can be rebuilt at any time before then. The machine
            names itself when it enrolls.
          </DialogDescription>
        </DialogHeader>
        <NodeKeySetup keyText={keyText} />
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Display state of a setup key: redeemed, expired unused, or still usable. */
function keyState(usedAt: string | null, expiresAt: string): "used" | "expired" | "unused" {
  if (usedAt) return "used";
  return Date.parse(expiresAt) < Date.now() ? "expired" : "unused";
}

/**
 * The caller's node setup keys, each with its OWN KEY TEXT, and revocable.
 *
 * Two things changed here on 2026-09-17. The row used to be titled by the label
 * the Add-node dialog asked for; that question is gone (a node names itself on the
 * machine that becomes it), and the label had one job left — naming a row whose key
 * you could not read — so the key is the title now. And reading it here is the POINT:
 * a minted key the dialog was closed on used to be an open enrollment door that could
 * only be CLOSED, never re-read, so the remedy was revoke and re-mint. That is why the
 * card also still carries what it always carried — `usedAt` and `expiresAt` decide
 * `keyState`, and a used or expired row's key is inert on sight.
 *
 * The third act here arrived with the 2026-09-23 audit fix (item 4): an
 * ADMIN's switch to "All instance keys". Before it, a non-admin's outstanding
 * key was a door no admin could close early — the list was owner-scoped and
 * the delete owner-filtered. The switch is gated on the server's own
 * `viewerIsAdmin` (never re-derived here), the read names each row's creator,
 * and the same Revoke button now closes a foreign row.
 */
export function SetupKeysSection() {
  const { data: settings } = usePublicSettings();
  const isAdmin = settings?.viewerIsAdmin === true;
  const [showAll, setShowAll] = useState(false);
  // One query per shape, each `enabled` only while it answers the screen —
  // the admin read is a widening and must not fire for a viewer who cannot
  // use it, nor for an admin who never asked.
  const own = useSetupKeys(!showAll);
  const every = useAllSetupKeys(isAdmin && showAll);
  const q = showAll ? every : own;
  const rows: CardKeyRow[] | undefined = showAll ? every.data?.keys : own.data?.keys;
  const remove = useDeleteSetupKey();
  const [rowError, setRowError] = useState<Record<string, string>>({});
  // The key whose setup steps are open, or null. Held as the KEY TEXT rather than the
  // row id because that is exactly what the dialog needs and nothing else does.
  const [setupFor, setSetupFor] = useState<string | null>(null);

  // The verb follows the row's state (operator, 2026-09-22, on the live
  // window: "If the key is consumed, does the revoke label make sense here?"
  // — no). An UNUSED row's key still opens a door, and deleting it REVOKES
  // that door. A USED or EXPIRED row's key is inert — revoking is not a
  // thing that can happen to it anymore — so the button and the dialog say
  // REMOVE and the description says plainly that only the record goes.
  // The title never carries the key itself (same ruling: "Can we not have
  // the key in the title? It looks really awful"): it is 43 characters of
  // random string, the row just displayed it in mono, and a wrapped blob of
  // base62 where a question should be reads as an error, not a prompt. The
  // description quotes it in mono instead — which key is named, in one line
  // of the body where a long token belongs.
  async function dismiss(id: string, key: string, state: "unused" | "used" | "expired") {
    setRowError((prev) => ({ ...prev, [id]: "" }));
    const unused = state === "unused";
    const ok = await confirmAction({
      title: unused ? "Revoke this setup key?" : "Remove this setup key?",
      description: unused
        ? `${key} will no longer enroll a node. It is deleted here and refused at enrollment.`
        : `${key} is ${state}, so there is nothing to revoke. This only deletes its record from this list.`,
      confirmLabel: unused ? "Revoke" : "Remove",
      danger: unused,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [id]: errMessage(err, unused ? "Could not revoke the key." : "Could not remove the key."),
      }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup keys</CardTitle>
        <CardDescription>
          Single-use enrollment credentials, valid 24 h. Each key stays listed here until it is used, expires, or is
          revoked, so the Add-node dialog is not the only place one can be read.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Switch checked={showAll} onCheckedChange={setShowAll} aria-label="List every account's setup keys" />
            <Label>List every account's setup keys</Label>
          </div>
        )}
        {q.error && <p className="text-destructive text-detail">Couldn't load setup keys.</p>}
        {!q.error && q.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {!q.error && rows?.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {showAll ? "No setup keys on any account yet." : "No setup keys yet."}
          </p>
        )}
        {rows?.map((k) => {
          const state = keyState(k.usedAt, k.expiresAt);
          return (
            <div key={k.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  {/* The key is the row's identity now, so it gets the affordance a
                      person needs with it: shown in full, and one press to take it.
                      `label` over `detail` is the line-item rule (design-system): the
                      key carries the row's weight at the label size — it had no role
                      class and inherited the 16 px body, which on a 43-character
                      token reads as a shout (operator, 2026-09-22). Mono was already
                      on the parent span; the role keeps it legible, not bigger. */}
                  <p className="font-mono font-strong text-label">
                    <CopyableValue value={k.key} label="Setup key" />
                  </p>
                  <p className="text-detail text-muted-foreground">
                    created {new Date(k.createdAt).toLocaleString()}
                    {k.consumedNodeId
                      ? ` · enrolled ${k.consumedNodeId}`
                      : ` · expires ${new Date(k.expiresAt).toLocaleString()}`}
                    {/* The admin read's one addition: whose door this row is. */}
                    {k.ownerLabel ? ` · by ${k.ownerLabel}` : ""}
                  </p>
                </div>
                <Badge variant={state === "unused" ? "success" : state === "expired" ? "warning" : "muted"}>
                  {state}
                </Badge>
                {/* On the USABLE row only. The card exists because a key the dialog was
                    closed on was recoverable; this closes the other half of that — the
                    COMMAND, which until now could only be re-read by minting a second
                    key. A used or expired row gets no such button: its key is inert, and
                    walking someone to a 401 they cannot act on is not an instruction. */}
                {state === "unused" && (
                  <Button variant="outline" size="sm" onClick={() => setSetupFor(k.key)}>
                    Setup
                  </Button>
                )}
                {/* Revoke while the key can still open a door; Remove once it
                    cannot (operator, 2026-09-22). The inert row's button is not
                    danger-styled either — deleting a spent record is list
                    tidying, the destructive style is reserved for closing a
                    live enrollment door. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void dismiss(k.id, k.key, state)}
                  disabled={remove.isPending}
                >
                  {state === "unused" ? "Revoke" : "Remove"}
                </Button>
              </div>
              {rowError[k.id] && <p className="text-destructive text-detail">{rowError[k.id]}</p>}
            </div>
          );
        })}
        {/* Portalled, so its place in this tree is only about which card it belongs to. */}
        {setupFor && <KeySetupDialog keyText={setupFor} onClose={() => setSetupFor(null)} />}
      </CardContent>
    </Card>
  );
}
