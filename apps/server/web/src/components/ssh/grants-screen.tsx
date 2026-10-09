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
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { Checkbox } from "@/components/ui/checkbox";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
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
import {
  useCreateSshGrant,
  useRevokeSshGrant,
  useSshGrants,
  useSshNodeRoster,
  useUpdateSshGrant,
} from "@/hooks/use-ssh";
import { fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { nodeOptionLabel } from "@/lib/node-label";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { grantSelectionError, type SshGrant } from "@/lib/ssh";

/**
 * The grants screen (spec 2026-10-08 §6.1, §8): the owner's standing key
 * grants, the selected public identities that carry them, the name/selector
 * edit, and the revoke. The rows are line items, `label` over `detail`: the
 * name, then machine and selector, then the fingerprints (public `SHA256:`
 * identifiers, deliberately on the owner's own screen; "which keys serve" is
 * what the owner manages).
 *
 * Which keys serve is IMMUTABLE by design: the server refuses to widen a
 * standing selection (spec §6.1), so the edit dialog touches only what the
 * PATCH route accepts - name and destination selector - and has no key
 * picker; the way to change a standing selection is revoke and create again.
 * The KEY PICKER lives where a selection is BORN: the create dialog (spec §8,
 * Task 18) reads the chosen key home's live roster and POSTs the same create
 * path an approved first use writes. Revoke is the screen's one destructive
 * act: it cuts both ways instantly (the row goes, live relays under it are
 * torn down), so it confirms, with the consequence said in the body and a
 * STATIC title.
 */
export function GrantsScreen() {
  const query = useSshGrants();
  const view = query.data;
  const { data: nodeData } = useNodes();
  const revoke = useRevokeSshGrant();
  const grants = view?.grants ?? [];
  const [editingGrant, setEditingGrant] = useState<SshGrant | null>(null);
  const [creating, setCreating] = useState(false);

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
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Key grants</CardTitle>
          <CardDescription>
            A grant gives permission to use selected SSH keys for a destination. The keys stay on their machine.
            Revoking ends connections using that permission.
          </CardDescription>
        </div>
        {/* §8's create door (Task 18): the same row an approved first use writes, built from A's live roster. */}
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus /> Create grant
        </Button>
      </CardHeader>
      <CardContent>
        {query.isPending || query.isError ? (
          <SshQueryStatus query={query} label="key grants" />
        ) : grants.length === 0 ? (
          <p className="text-detail text-muted-foreground">
            No key grants yet. Approve a connection request above, or create permission here by choosing a machine and
            its loaded SSH keys.
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
        {creating && <CreateGrantDialog onOpenChange={setCreating} />}
      </CardContent>
    </Card>
  );
}

/** Create's two text fields; emptiness is a gap (gold), the server's refusal stays red. */
const grantCreateSchema = z.object({ name: z.string(), selector: z.string() }).superRefine((values, ctx) => {
  if (values.name.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["name"], message: "A name is required", gap: true });
  }
  if (values.selector.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["selector"], message: "A destination selector is required", gap: true });
  }
});

/**
 * §8's manual create, surfaced in Task 18: the picker chooses a key home,
 * reads ITS live roster through the roster-by-node route (no pending request
 * needed - that absence was the whole gap), and POSTs the existing create
 * contract, so the row is identical to the one an approved first use writes.
 *
 * The dialog title is static (ruling 2026-09-30). The key home list mirrors
 * the create gate's own doors (an agent node you own with SSH switched on);
 * the roster fetch keeps the approval screen's honesty split - an unreachable
 * key home shows ITS named error, and only an answer from a live agent may
 * render "holds no keys". The cap is a red hard error the moment the ninth
 * key is ticked: the server refuses over-cap outright, and this screen
 * refuses before it, so a truncation can never be mistaken for the selection.
 */
function CreateGrantDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { data: nodeData } = useNodes();
  const create = useCreateSshGrant();
  const [serverError, setServerError] = useState<string | null>(null);
  const [keyHomeId, setKeyHomeId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const roster = useSshNodeRoster(keyHomeId === "" ? null : keyHomeId);

  // SSH is owner-reserved on agent machines and `local` is never a key home
  // (acceptance (d)); the picker offers exactly the machines the route's gate
  // accepts, so a pick here is a machine that can answer.
  const keyHomeOptions: ComboboxOption[] = (Array.isArray(nodeData?.nodes) ? nodeData.nodes : [])
    .filter((n) => n.kind === "agent" && n.sshEnabled && n.access === "owner")
    .map((n) => ({ value: n.id, label: nodeOptionLabel(n) }));

  // The roster is the WHOLE candidate set (the approval card's fence): the
  // body may only carry fingerprints the live agent still reports.
  const rosterHeld = roster.data ? new Set(roster.data.identities.map((identity) => identity.fingerprint)) : null;
  const submitted = rosterHeld ? selected.filter((fingerprint) => rosterHeld.has(fingerprint)) : [];
  const selectionError = grantSelectionError(submitted);

  const form = makeForm({
    defaultValues: { name: "", selector: "" },
    validator: grantCreateSchema,
    onSubmit: async (values) => {
      // The guard behind the gate (substrate contract): Enter-path submits
      // and render races land here even though the button is swept.
      const name = values.name.trim();
      const selector = values.selector.trim();
      if (name === "" || selector === "" || keyHomeId === "" || !roster.data) return;
      if (submitted.length === 0 || selectionError) return;
      setServerError(null);
      try {
        await create.mutateAsync({ nodeId: keyHomeId, name, selector, fingerprints: submitted });
        onOpenChange(false);
      } catch (err) {
        setServerError(errMessage(err, "The grant could not be created."));
      }
    },
  });
  const disabled =
    useSubmitDisabled(form, create.isPending) || !roster.data || submitted.length === 0 || !!selectionError;

  return (
    <Dialog open onOpenChange={formDialogOpenChange(onOpenChange)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create grant</DialogTitle>
          <DialogDescription>
            Choose the machine that holds your SSH keys, then select which keys may connect to the destination. The
            machine must be online with SSH enabled and keys loaded in its SSH agent (ssh-add).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="grant-create-node">
            SSH keys from
            <RequiredMark />
          </Label>
          <SearchableSelect
            id="grant-create-node"
            value={keyHomeId}
            onValueChange={(value) => {
              setKeyHomeId(value);
              setSelected([]); // a new key home answers a NEW roster; old ticks are not its keys
            }}
            placeholder="Choose the machine holding your keys"
            options={keyHomeOptions}
            emptyText="No machine you own has SSH switched on yet. Switch it on from a machine's settings first."
          />
        </div>
        {keyHomeId !== "" && (
          <div>
            <Label>Choose the keys allowed for this destination</Label>
            {roster.isPending && (
              <p className="mt-1 text-detail text-muted-foreground">Asking the key home&apos;s agent…</p>
            )}
            {roster.isError && (
              <p role="alert" className="mt-1 text-destructive text-detail">
                {errMessage(roster.error, "The key home could not be reached. Nothing was saved.")}
              </p>
            )}
            {roster.data && roster.data.identities.length === 0 && (
              <p className="mt-1 text-detail text-muted-foreground">
                No SSH keys are loaded on this machine. Load a key with ssh-add there, then refresh the key list.
              </p>
            )}
            {roster.data && roster.data.identities.length > 0 && (
              <ul className="mt-2 space-y-2">
                {roster.data.identities.map((identity) => (
                  <li key={identity.fingerprint} className="flex items-start gap-3">
                    <Checkbox
                      className="mt-1"
                      aria-label={identity.fingerprint}
                      checked={selected.includes(identity.fingerprint)}
                      onCheckedChange={() =>
                        setSelected((prev) =>
                          prev.includes(identity.fingerprint)
                            ? prev.filter((f) => f !== identity.fingerprint)
                            : [...prev, identity.fingerprint],
                        )
                      }
                    />
                    <div className="min-w-0">
                      <div className="break-all font-mono text-detail">{identity.fingerprint}</div>
                      {identity.comment && (
                        <div className="truncate text-detail text-muted-foreground">{identity.comment}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" size="sm" disabled={roster.isFetching} onClick={() => void roster.refetch()}>
              Refresh keys
            </Button>
            {selectionError && (
              <p role="alert" className="mt-2 text-destructive text-detail">
                {selectionError}
              </p>
            )}
          </div>
        )}
        <form.Field name="name">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="grant-create-name">
                Grant name
                <RequiredMark />
              </Label>
              <Input
                id="grant-create-name"
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
              <Label htmlFor="grant-create-selector">
                Destination hostname or pattern
                <RequiredMark />
              </Label>
              <Input
                id="grant-create-selector"
                value={field.state.value}
                placeholder="git.example.com or *.example.com"
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={disabled}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                Destination hostname or pattern
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
