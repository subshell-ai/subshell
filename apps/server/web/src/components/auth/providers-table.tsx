import { Badge, confirmAction, errMessage, Switch } from "@internal/node-admin";
import { Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { useDeleteAuthProvider, usePatchAuthProvider } from "@/hooks/use-auth-providers";
import {
  EMAIL_PROVIDER_ID,
  KIND_LABELS,
  type PatchAuthProviderBody,
  type ProviderAdminView,
  registrationDisplay,
} from "@/types/auth-provider";

/**
 * The provider list on `/settings/auth` (spec §7): every door with its half
 * switches live on the row, edit/delete behind the shared row menu.
 *
 * The row switches PATCH exactly one field each, so the server owns the
 * decisions the combination makes, and the last-door refusal (`LAST_SIGN_IN_
 * DOOR`) arrives as the server's own sentence, shown on the row that asked
 * for it. The email row is in the table and out of the dialog: its toggles
 * PATCH, its `null` registration flag renders the computed gate
 * (`registrationDisplay`), and it has no id to rename, no kind to flip and no
 * delete (the table offers no menu; the route refuses anyway).
 *
 * Row errors retire themselves after 8 s, the users rows' discipline: a
 * refusal kept on screen past the moment it described becomes a second,
 * wrong state.
 */
export function ProvidersTable({
  providers,
  registrationComputedOpen,
  onEdit,
}: {
  /** The list as the server ordered it */
  providers: readonly ProviderAdminView[];
  /** The gate's answer for the email row's null flag (`allowRegistrations`) */
  registrationComputedOpen: boolean;
  onEdit: (provider: ProviderAdminView) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pr-4 pb-2 font-strong">Name</th>
            <th className="pr-4 pb-2 font-strong">Kind</th>
            <th className="pr-4 pb-2 font-strong">Sign-in</th>
            <th className="pr-4 pb-2 font-strong">Registration</th>
            <th className="pr-4 pb-2 font-strong">Approval</th>
            <th className="pr-4 pb-2 font-strong">Enabled</th>
            <th className="pb-2 text-right font-strong" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <ProviderRow key={p.id} provider={p} computedOpen={registrationComputedOpen} onEdit={onEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderRow({
  provider,
  computedOpen,
  onEdit,
}: {
  provider: ProviderAdminView;
  computedOpen: boolean;
  onEdit: (provider: ProviderAdminView) => void;
}) {
  const isEmail = provider.id === EMAIL_PROVIDER_ID;
  const patch = usePatchAuthProvider();
  const remove = useDeleteAuthProvider();
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function reportError(message: string): void {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => setError(null), 8000);
  }

  async function toggleField(body: PatchAuthProviderBody) {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
    try {
      await patch.mutateAsync({ id: provider.id, body });
    } catch (err) {
      // The last-door refusal lands here with the server's own escape hatch in
      // its sentence; showing it verbatim keeps one explanation of the rule,
      // on the side that enforces it.
      reportError(errMessage(err, "Couldn't change the provider."));
    }
  }

  async function confirmDelete(): Promise<void> {
    setError(null);
    const ok = await confirmAction({
      title: `Remove "${provider.name}"?`,
      description:
        "The door closes and stops appearing on the login page. People who signed in through it keep their accounts and everything they own.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(provider.id);
    } catch (err) {
      reportError(errMessage(err, "Couldn't remove the provider."));
    }
  }

  const busy = patch.isPending || remove.isPending;
  const reg = registrationDisplay(provider, computedOpen);

  const items: ActionItem[] = isEmail
    ? []
    : [
        { label: "Edit", icon: Pencil, onSelect: () => onEdit(provider) },
        {
          label: "Remove",
          icon: Trash2,
          destructive: true,
          onSelect: () => void confirmDelete(),
        },
      ];

  return (
    <tr className="border-b align-middle last:border-0">
      <td className="py-2 pr-4">
        {provider.name}
        {error && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
      </td>
      <td className="py-2 pr-4">
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={provider.kind === "email" ? "secondary" : "default"}>{KIND_LABELS[provider.kind]}</Badge>
          {!provider.endpointsResolved && !isEmail && <Badge variant="warning">Not verified</Badge>}
        </div>
      </td>
      <td className="py-2 pr-4">
        <Switch
          checked={provider.signInEnabled}
          onCheckedChange={(c) => void toggleField({ signInEnabled: c })}
          disabled={busy}
          aria-label={`Sign-in for ${provider.name}`}
        />
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2">
          <Switch
            checked={reg.checked}
            // A null flag flips out of "computed": the first press states an
            // explicit answer, which is how the General page's toggle does it.
            onCheckedChange={(c) => void toggleField({ registrationEnabled: c })}
            disabled={busy}
            aria-label={`Registration for ${provider.name}`}
          />
          {reg.computed && <span className="text-detail text-muted-foreground">{reg.label}</span>}
        </div>
      </td>
      <td className="py-2 pr-4">
        <Switch
          checked={provider.requireApproval}
          onCheckedChange={(c) => void toggleField({ requireApproval: c })}
          disabled={busy}
          aria-label={`Approval required for ${provider.name}`}
        />
      </td>
      <td className="py-2 pr-4">
        <Switch
          checked={provider.enabled}
          onCheckedChange={(c) => void toggleField({ enabled: c })}
          disabled={busy}
          aria-label={`Enabled for ${provider.name}`}
        />
      </td>
      <td className="py-2 text-right">
        {isEmail ? (
          <span className="text-detail text-muted-foreground">Built in</span>
        ) : (
          <ActionsMenu label={provider.name} items={items} disabled={busy} />
        )}
      </td>
    </tr>
  );
}
