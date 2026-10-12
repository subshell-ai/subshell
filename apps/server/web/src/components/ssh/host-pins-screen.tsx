import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyableValue,
  confirmAction,
  errMessage,
  Input,
  Label,
} from "@internal/node-admin";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { SshQueryStatus } from "@/components/ssh/query-status";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { RequiredMark } from "@/components/ui/required-mark";
import { Textarea } from "@/components/ui/textarea";
import { useCreateSshHostPin, useDeleteSshHostPin, useSshHostPins } from "@/hooks/use-ssh";
import { fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import type { SshHostPin } from "@/lib/ssh";

/** Saved destination host keys, scoped to the signed-in user.
 * Removing a pin allows Subshell to capture the key again on the next relay
 * connection. Users must verify a changed key before removing its pin.
 * A supplied known_hosts entry also supports destinations that use HostKeyAlias.
 */
export function HostPinsScreen() {
  const query = useSshHostPins();
  const view = query.data;
  const pins = view?.pins ?? [];
  const [addOpen, setAddOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Saved host keys</CardTitle>
          <CardDescription>
            Subshell saves host keys to check that you’re connecting to the same destination. If a key changes, verify
            the replacement with the destination’s administrator before removing the saved key.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus /> Add host key
        </Button>
      </CardHeader>
      <CardContent>
        {query.isPending || query.isError ? (
          <SshQueryStatus query={query} label="destination trust" />
        ) : pins.length === 0 ? (
          <p className="text-detail text-muted-foreground">
            No host keys saved yet. When you first connect using keys from another machine, Subshell saves the
            destination’s host key from that machine’s known_hosts file.
          </p>
        ) : (
          <ul className="space-y-4">
            {pins.map((pin) => (
              <PinRow key={pin.id} pin={pin} />
            ))}
          </ul>
        )}
        {addOpen && <AddPinDialog onOpenChange={setAddOpen} />}
      </CardContent>
    </Card>
  );
}

/** One pinned destination and the delete that re-opens its TOFU decision. */
function PinRow({ pin }: { pin: SshHostPin }) {
  const remove = useDeleteSshHostPin();

  async function drop() {
    const ok = await confirmAction({
      // Static title; the destination rides the body (ruling 2026-09-30).
      title: "Remove this host key?",
      description: `"${pin.destination}" will use a host key from the machine supplying your SSH keys on the next connection. Verify any replacement with the destination’s administrator before reconnecting.`,
      confirmLabel: "Remove host key",
      danger: true,
    });
    if (!ok) return;
    remove.mutate(pin.destination);
  }

  return (
    <li className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="break-all font-strong text-label">{pin.destination}</div>
        <div className="break-all font-mono text-detail">
          <CopyableValue value={pin.fingerprint} label={`Fingerprint for ${pin.destination}`} />
        </div>
        <div className="text-detail text-muted-foreground">
          Saved {pin.createdAt.slice(0, 10)} · last match {pin.updatedAt.slice(0, 10)}
        </div>
        {remove.isError && remove.variables === pin.destination && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(remove.error, "Couldn't remove the saved host key.")}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove host key for ${pin.destination}`}
        title={`Remove host key for ${pin.destination}`}
        onClick={() => void drop()}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

/** The add dialog's one validity rule; emptiness is a gap (gold), the server's refusal is the red one. */
const hostPinSchema = z
  .object({
    destination: z.string(),
    hostKey: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.destination.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["destination"],
        message: "A destination is required",
        gap: true,
      });
    }
    if (values.hostKey.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["hostKey"], message: "A host key line is required", gap: true });
    }
  });

/**
 * `POST /api/ssh/host-pins` (the explicit-pin door). The dialog title is
 * static: what the person types lands in the fields and the body, never in
 * the heading. A server refusal (a bad canonical spelling, a destination
 * already pinned to a DIFFERENT key) is the red line: it says "what you typed
 * is wrong", and for a conflicting pin the sentence IS the recovery map -
 * delete the standing pin first, nothing overwrites.
 */
function AddPinDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const create = useCreateSshHostPin();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = makeForm({
    defaultValues: { destination: "", hostKey: "" },
    validator: hostPinSchema,
    onSubmit: async (values) => {
      const destination = values.destination.trim();
      const hostKey = values.hostKey.trim();
      if (destination === "" || hostKey === "") return;
      setServerError(null);
      try {
        await create.mutateAsync({ destination, hostKey });
        onOpenChange(false);
      } catch (err) {
        setServerError(errMessage(err, "Couldn't save the host key."));
      }
    },
  });
  const disabled = useSubmitDisabled(form, create.isPending);

  return (
    <Dialog open onOpenChange={formDialogOpenChange(onOpenChange)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add host key</DialogTitle>
          <DialogDescription>
            Add a host key you’ve verified with the destination’s administrator. Use this when the machine supplying
            your SSH keys has no saved key for the destination.
          </DialogDescription>
        </DialogHeader>
        <form.Field name="destination">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="host-pin-destination">
                Destination
                <RequiredMark />
              </Label>
              <Input
                id="host-pin-destination"
                value={field.state.value}
                placeholder="user@host:22"
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
              {field.state.meta.isTouched &&
                (() => {
                  const shown = fieldErrorToned(field.state.meta.errors);
                  return (
                    shown && (
                      <p
                        role="alert"
                        className={shown.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail"}
                      >
                        {shown.text}
                      </p>
                    )
                  );
                })()}
            </div>
          )}
        </form.Field>
        <form.Field name="hostKey">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="host-pin-key">
                Host key
                <RequiredMark />
              </Label>
              <Textarea
                id="host-pin-key"
                value={field.state.value}
                placeholder="host ssh-ed25519 AAAA..."
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
              <p className="text-detail text-muted-foreground">One OpenSSH known_hosts line for that destination.</p>
              {field.state.meta.isTouched &&
                (() => {
                  const shown = fieldErrorToned(field.state.meta.errors);
                  return (
                    shown && (
                      <p
                        role="alert"
                        className={shown.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail"}
                      >
                        {shown.text}
                      </p>
                    )
                  );
                })()}
            </div>
          )}
        </form.Field>
        {serverError && (
          <p role="alert" className="text-destructive text-detail">
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={disabled}>
            {create.isPending ? "Adding…" : "Add host key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
