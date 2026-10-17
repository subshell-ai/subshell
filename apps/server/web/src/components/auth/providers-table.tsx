import { Card, CardContent, CardHeader, CardTitle, confirmAction, errMessage } from "@internal/node-admin";
import { Pencil, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { ProviderSettingsDialog } from "@/components/auth/provider-settings-dialog";
import { FactList } from "@/components/fact-list";
import { useDeleteAuthProvider, usePatchAuthProvider } from "@/hooks/use-auth-providers";
import {
  EMAIL_PROVIDER_ID,
  KIND_LABELS,
  type PatchAuthProviderBody,
  type ProviderAdminView,
  registrationDisplay,
} from "@/types/auth-provider";

/** Read-only provider values; configuration and credentials have separate dialogs. */
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
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Sign-in providers</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="@container overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="whitespace-nowrap pr-4 pb-2 font-strong">Name</th>
                <th className="@2xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Provider</th>
                <th className="@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Sign-in</th>
                <th className="@lg:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Registration</th>
                <th className="@3xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Approval</th>
                <th className="whitespace-nowrap pr-4 pb-2 font-strong">Enabled</th>
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
      </CardContent>
    </Card>
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
  const [configureOpen, setConfigureOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    [],
  );

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
          <div className="mt-3">
            <FactList
              rows={[
                { label: "Slug id", value: provider.id, mono: true },
                { label: "Issuer", value: provider.issuer ?? "Not applicable", mono: true },
              ]}
            />
          </div>
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

  const items: ActionItem[] = [
    {
      label: "Configure",
      icon: Settings2,
      onSelect: () => {
        setError(null);
        setConfigureOpen(true);
      },
    },
    ...(!isEmail
      ? [
          { label: "Edit", icon: Pencil, onSelect: () => onEdit(provider) },
          { label: "Remove", icon: Trash2, destructive: true, onSelect: () => void confirmDelete() },
        ]
      : []),
  ];

  return (
    <>
      <tr className="border-b align-middle last:border-0">
        <td className="h-8 @sm:w-1/3 w-full max-w-0 py-0 pr-4">
          <span className="block truncate" title={provider.name}>
            {provider.name}
          </span>
          {!provider.endpointsResolved && !isEmail && <span className="block text-warning">Not verified</span>}
          {error && !configureOpen && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </td>
        <td className="@2xl:table-cell hidden h-8 py-0 pr-4">{KIND_LABELS[provider.kind]}</td>
        <td className="@sm:table-cell hidden h-8 py-0 pr-4">{provider.signInEnabled ? "Yes" : "No"}</td>
        <td className="@lg:table-cell hidden h-8 py-0 pr-4">{reg.checked ? "Yes" : "No"}</td>
        <td className="@3xl:table-cell hidden h-8 py-0 pr-4">{provider.requireApproval ? "Yes" : "No"}</td>
        <td className="h-8 py-0 pr-4">{provider.enabled ? "Yes" : "No"}</td>
        <td className="h-8 w-px py-0 text-right">
          <ActionsMenu
            label={provider.name}
            items={items}
            disabled={busy}
            disabledReason="Wait for the sign-in provider change to finish."
          />
        </td>
      </tr>
      {configureOpen && (
        <ProviderSettingsDialog
          provider={provider}
          computedOpen={computedOpen}
          soleOpen={soleOpen}
          busy={busy}
          error={error}
          onChange={(body) => void toggleField(body)}
          onClose={() => setConfigureOpen(false)}
        />
      )}
    </>
  );
}
