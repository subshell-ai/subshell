import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  confirmAction,
  errMessage,
  Input,
  Label,
} from "@internal/node-admin";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
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
import { useNodes } from "@/hooks/use-nodes";
import { useRevokeSshGrant, useSshGrants, useUpdateSshGrant } from "@/hooks/use-ssh";
import { fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import type { SshGrant } from "@/lib/ssh";

/**
 * The grants screen (spec 2026-10-08 §6.1, §8): the owner's standing key
 * grants, the selected public identities that carry them, the name/selector
 * edit, and the revoke. The rows are line items, `label` over `detail`: the
 * name, then machine and selector, then the fingerprints (public `SHA256:`
 * identifiers, deliberately on the owner's own screen; "which keys serve" is
 * what the owner manages).
 *
 * Which keys serve is IMMUTABLE by design: the server refuses to widen a
 * standing selection (spec §6.1), so this screen edits only what the PATCH
 * route accepts - name and destination selector - and has no key picker at
 * all; the way to change a selection is revoke and re-ask. Revoke is the
 * screen's one destructive act: it cuts both ways instantly (the row goes,
 * live relays under it are torn down), so it confirms, with the consequence
 * said in the body and a STATIC title.
 */
export function GrantsScreen() {
  const { data: view } = useSshGrants();
  const { data: nodeData } = useNodes();
  const revoke = useRevokeSshGrant();
  const grants = view?.grants ?? [];
  const [editingGrant, setEditingGrant] = useState<SshGrant | null>(null);

  const nameById = new Map<string, string>(
    (Array.isArray(nodeData?.nodes) ? nodeData.nodes : []).map((n) => [n.id, n.name]),
  );

  async function revokeGrant(grant: SshGrant) {
    const ok = await confirmAction({
      // Static title (ruling 2026-09-30); the body carries the name.
      title: "Revoke this grant?",
      description: `"${grant.name}" stops signing right away, and every session already running under it is cut. You can grant again from the next approval.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    revoke.mutate(grant.id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Key grants</CardTitle>
        <CardDescription>
          Which machine&apos;s agent keys sign for which destinations. Revoking cuts the grant and every live session
          running under it at once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {grants.length === 0 ? (
          <p className="text-detail text-muted-foreground">
            No key grants yet. A first-use approval you answer yes becomes a standing grant here.
          </p>
        ) : (
          <ul className="space-y-4">
            {grants.map((grant) => (
              <li key={grant.id} className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate font-strong text-label">{grant.name}</div>
                  <div className="truncate text-detail text-muted-foreground">
                    {[nameById.get(grant.keyHomeNodeId) ?? grant.keyHomeNodeId, grant.resolvedSelector].join(" · ")}
                  </div>
                  {grant.fingerprints.map((fingerprint) => (
                    <div key={fingerprint} className="break-all font-mono text-detail">
                      {fingerprint}
                    </div>
                  ))}
                  <div className="text-detail text-muted-foreground">
                    {grant.createdVia === "first-use" ? "From a first-use approval" : "Added by hand"} ·{" "}
                    {grant.createdAt.slice(0, 10)}
                  </div>
                  {revoke.isError && revoke.variables === grant.id && (
                    <p role="alert" className="text-destructive text-detail">
                      {errMessage(revoke.error, "The grant could not be revoked.")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit grant ${grant.name}`}
                    title={`Edit ${grant.name}`}
                    onClick={() => setEditingGrant(grant)}
                    className="text-muted-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke grant ${grant.name}`}
                    title={`Revoke ${grant.name}`}
                    onClick={() => void revokeGrant(grant)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {editingGrant && (
          <EditGrantDialog
            grant={editingGrant}
            onOpenChange={(open) => {
              if (!open) setEditingGrant(null);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The edit's two fields; emptiness is a gap (gold), the server's refusal is the red line. */
const grantEditSchema = z.object({ name: z.string(), selector: z.string() }).superRefine((values, ctx) => {
  if (values.name.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["name"], message: "A name is required", gap: true });
  }
  if (values.selector.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["selector"], message: "A selector is required", gap: true });
  }
});

/**
 * §8's name/selector edit over `PATCH /api/ssh/grants/:id`. The dialog title
 * is static (ruling 2026-09-30): the grant's name rides the body. The dialog
 * says what it does NOT do: which keys serve is immutable, so no fingerprint
 * field exists here and the mutation gives them no way onto the wire - change
 * the key set by revoking and granting again.
 */
function EditGrantDialog({ grant, onOpenChange }: { grant: SshGrant; onOpenChange: (open: boolean) => void }) {
  const update = useUpdateSshGrant();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = makeForm({
    defaultValues: { name: grant.name, selector: grant.resolvedSelector },
    validator: grantEditSchema,
    onSubmit: async (values) => {
      const name = values.name.trim();
      const selector = values.selector.trim();
      if (name === "" || selector === "") return;
      setServerError(null);
      try {
        await update.mutateAsync({ grantId: grant.id, name, selector });
        onOpenChange(false);
      } catch (err) {
        setServerError(errMessage(err, "The grant could not be updated."));
      }
    },
  });
  const disabled = useSubmitDisabled(form, update.isPending);

  return (
    <Dialog open onOpenChange={formDialogOpenChange(onOpenChange)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit grant</DialogTitle>
          <DialogDescription>
            "{grant.name}" keeps the same keys. This dialog changes only the name and destination; to change which keys
            serve, revoke and grant again.
          </DialogDescription>
        </DialogHeader>
        <form.Field name="name">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="grant-edit-name">
                Grant name
                <RequiredMark />
              </Label>
              <Input
                id="grant-edit-name"
                value={field.state.value}
                maxLength={120}
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
        <form.Field name="selector">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="grant-edit-selector">
                Destination selector
                <RequiredMark />
              </Label>
              <Input
                id="grant-edit-selector"
                value={field.state.value}
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
        {serverError && (
          <p role="alert" className="text-destructive text-detail">
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={disabled}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
