import { Badge, confirmAction, errMessage, Switch } from "@internal/node-admin";
import { Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeleteAuthProvider, usePatchAuthProvider } from "@/hooks/use-auth-providers";
import {
  EMAIL_PROVIDER_ID,
  KIND_LABELS,
  type PatchAuthProviderBody,
  type ProviderAdminView,
  registrationDisplay,
} from "@/types/auth-provider";

/**
 * The tooltip's sentence (operator's wording, 2026-09-25). Deliberately not
 * the server's longer refusal: the disabled control already stops the act, so
 * the tooltip names the rule, not the escape hatch — the CLI remedy lives in
 * the 409's sentence for the rare race that still reaches it.
 */
export const LAST_OPEN_PROVIDER_COPY = "You cannot disable the last provider.";

/**
 * The provider list on `/settings/auth` (spec §7): every provider with its half
 * switches live on the row, edit/delete behind the shared row menu.
 *
 * The last open provider's Sign-in and Enabled switches are DISABLED with a
 * tooltip naming the reason (operator ruling, 2026-09-25): clicking into a
 * 409 to learn the guard exists is the ugly path, and the server stays the
 * enforcement anyway, so the disabled state is courtesy computed from the
 * list, never a second truth. The Registration and Approval switches never
 * close a way in and stay live.
 *
 * The row switches PATCH exactly one field each, so the server owns the
 * decisions the combination makes, and a refusal that still races in (an
 * admin's two tabs, another admin's write) arrives as the server's own
 * sentence, shown on the row that asked for it. The email row is in the table and out of the dialog: its toggles
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
  // Courtesy arithmetic off the same list the rows render: a provider is
  // OPEN when both switches it owns are on (the server's guard counts
  // exactly that), and only a sole open row has anything to disable.
  const openCount = providers.filter((p) => p.enabled && p.signInEnabled).length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pr-4 pb-2 font-strong">Name</th>
            <th className="pr-4 pb-2 font-strong">Provider</th>
            <th className="pr-4 pb-2 font-strong">Sign-in</th>
            <th className="pr-4 pb-2 font-strong">Registration</th>
            <th className="pr-4 pb-2 font-strong">Approval</th>
            <th className="pr-4 pb-2 font-strong">Enabled</th>
            <th className="pb-2 text-right font-strong" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              computedOpen={registrationComputedOpen}
              soleOpen={openCount === 1 && p.enabled && p.signInEnabled}
              onEdit={onEdit}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderRow({
  provider,
  computedOpen,
  soleOpen,
  onEdit,
}: {
  provider: ProviderAdminView;
  computedOpen: boolean;
  /** The only open provider: its two close-capable switches are disabled. */
  soleOpen: boolean;
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
      // The last-provider refusal lands here with the server's own escape hatch in
      // its sentence; showing it verbatim keeps one explanation of the rule,
      // on the side that enforces it.
      reportError(errMessage(err, "Couldn't change the provider."));
    }
  }

  async function confirmDelete(): Promise<void> {
    setError(null);
    const ok = await confirmAction({
      title: "Remove provider?",
      description: (
        <>
          Removing the {provider.name} provider has the following effects:
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Nobody can sign in through it anymore, and it disappears from the login page.</li>
            <li>No accounts are deleted. Everyone keeps their data and their work.</li>
            <li>You can reverse this by adding a new provider with the same slug id and issuer URL.</li>
          </ul>
          {/* Which exact row this is, as quiet line items (operator,
              2026-09-25): the NAME on the headline is the admin's label and
              can repeat, so the two strings that actually identify the row —
              the slug id and the issuer — get label-over-value rows, the
              values in the mono foreground voice they wear everywhere else. */}
          <dl className="mt-2 space-y-2">
            <div>
              <dt className="text-muted-foreground">Slug id</dt>
              <dd className="font-mono text-detail text-foreground">{provider.id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Issuer</dt>
              <dd className="font-mono text-detail text-foreground">{provider.issuer ?? ""}</dd>
            </div>
          </dl>
        </>
      ),
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
        <LastOpenGuard soleOpen={soleOpen} srId={`last-open-${provider.id}-signin`}>
          <Switch
            checked={provider.signInEnabled}
            onCheckedChange={(c) => void toggleField({ signInEnabled: c })}
            disabled={busy || soleOpen}
            aria-label={`Sign-in for ${provider.name}`}
          />
        </LastOpenGuard>
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
        <LastOpenGuard soleOpen={soleOpen} srId={`last-open-${provider.id}-enabled`}>
          <Switch
            checked={provider.enabled}
            onCheckedChange={(c) => void toggleField({ enabled: c })}
            disabled={busy || soleOpen}
            aria-label={`Enabled for ${provider.name}`}
          />
        </LastOpenGuard>
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

/**
 * The disabled-switch carrier, built like the Add-node gate's (the enrollment
 * ruling, 2026-09-24, applies unchanged): a disabled control takes no hover,
 * so the TRIGGER is a wrapper span; it holds the tab stop a disabled switch
 * loses, and an sr-only span carries the sentence for readers since Base UI
 * marks the trigger but wires no association itself.
 */
function LastOpenGuard({ soleOpen, srId, children }: { soleOpen: boolean; srId: string; children: ReactNode }) {
  if (!soleOpen) return <>{children}</>;
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the real control is a disabled switch, which HTML removes from the tab order; the span is the tooltip's carrier, not content. */}
        <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-describedby={srId} />}>
          {children}
        </TooltipTrigger>
        <TooltipContent>{LAST_OPEN_PROVIDER_COPY}</TooltipContent>
      </Tooltip>
      <span id={srId} className="sr-only">
        {LAST_OPEN_PROVIDER_COPY}
      </span>
    </TooltipProvider>
  );
}
