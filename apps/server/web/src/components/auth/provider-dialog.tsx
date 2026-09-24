import { ApiError, Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { useEffect, useRef, useState } from "react";
import { entryOriginCandidates, normalizeOriginEntry } from "@/components/auth/entry-origins";
import { EntryPointsEditor } from "@/components/auth/entry-points-editor";
import { RegistrationPanel } from "@/components/auth/registration-panel";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateAuthProvider, usePatchAuthProvider, useTestAuthProvider } from "@/hooks/use-auth-providers";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { EMAIL_PROVIDER_ID, GOOGLE_ISSUER, type ProviderAdminView, previewProviderId } from "@/types/auth-provider";

/** The one fallback sentence for a save refusal that carries no server text. */
const SAVE_ERROR_FALLBACK = "Couldn't save the provider.";

/**
 * The add/edit dialog for one OIDC door (spec §7). The email row never opens
 * it: its kind and id are fixed and it has nothing to register, so the table
 * toggles are its whole surface.
 *
 * The form lives BELOW `DialogContent` and keys off the provider id, so every
 * open starts from the row it was opened on (Base UI unmounts hidden content;
 * a form living in `ProviderDialog` itself would carry the previous row's
 * half-typed issuer across closes).
 *
 * The two entry-point blocks are siblings, not sections of this file (review
 * Minor 5): `entry-origins.ts` holds the pure origin rules,
 * `entry-points-editor.tsx` the list editor, `registration-panel.tsx` the
 * IdP copy panel. This file is the form that owns their state and the fields
 * around them.
 */
export function ProviderDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create */
  provider: ProviderAdminView | null;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{provider ? `Edit ${provider.name}` : "Add provider"}</DialogTitle>
        </DialogHeader>
        {open && (
          <ProviderForm
            key={provider?.id ?? "new"}
            provider={provider}
            onDone={() => {
              onOpenChange(false);
              onSaved();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProviderForm({ provider, onDone }: { provider: ProviderAdminView | null; onDone: () => void }) {
  const editing = provider !== null;
  const { data: publicSettings } = usePublicSettings();

  // The canonical entry for a fresh dialog (spec §5a, list position 1):
  // APP_BASE_URL's origin, falling back to this browser's origin ONLY while
  // appBaseUrl is unknown — the same source order `lib/install-addresses`
  // documents for its pickers.
  const canonicalEntry =
    normalizeOriginEntry(publicSettings?.appBaseUrl ?? "") ?? normalizeOriginEntry(window.location.origin);

  // Create starts with kind "google" AND its issuer seeded: a dialog that
  // shows Google chosen but demands a paste of the issuer URL pretends the
  // preset is a click rather than the default.
  const [kind, setKind] = useState<"google" | "oidc">(provider && provider.kind !== "email" ? provider.kind : "google");
  const [name, setName] = useState(provider?.name ?? "");
  const [issuer, setIssuer] = useState(provider ? (provider.issuer ?? "") : GOOGLE_ISSUER);
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  // Edit starts BLANK: the list never carries the secret (§8), and a blank
  // save means "leave stored" — explicit clearing does not exist server-side.
  const [secret, setSecret] = useState("");
  // Create pre-adds the canonical entry (spec §5a); the seeded-array identity
  // lets the effect below tell our untouched seed from a list the admin has
  // edited (every edit mints a new array).
  const [entries, setEntries] = useState<string[]>(() =>
    provider ? [...(provider.entryOrigins ?? [])] : canonicalEntry === null ? [] : [canonicalEntry],
  );
  const seededEntries = useRef<string[] | null>(editing ? null : entries);
  useEffect(() => {
    if (editing || canonicalEntry === null) return;
    setEntries((prev) => (prev === seededEntries.current && prev[0] !== canonicalEntry ? [canonicalEntry] : prev));
  }, [editing, canonicalEntry]);
  const [signInEnabled, setSignInEnabled] = useState(provider?.signInEnabled ?? true);
  const [registrationEnabled, setRegistrationEnabled] = useState(provider?.registrationEnabled ?? false);
  const [requireApproval, setRequireApproval] = useState(provider?.requireApproval ?? false);
  const [domains, setDomains] = useState((provider?.allowedDomains ?? []).join(", "));
  const [saveError, setSaveError] = useState<unknown>(null);

  const create = useCreateAuthProvider();
  const patch = usePatchAuthProvider();
  const test = useTestAuthProvider();
  const busy = create.isPending || patch.isPending;

  const slug = previewProviderId(name);
  // The panel must show the id that WILL be stored: on create the dialog
  // sends this exact slug as `id`, so the preview and the truth are one
  // string (§5a's "live while filling").
  const displayId = editing ? provider.id : slug;
  const candidates = entryOriginCandidates({
    here: window.location.origin,
    baseUrl: publicSettings?.appBaseUrl,
    trustedOrigins: publicSettings?.trustedOrigins,
  });

  async function save(): Promise<void> {
    setSaveError(null);
    const shared = {
      name: name.trim(),
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      entryOrigins: entries,
      signInEnabled,
      registrationEnabled,
      requireApproval,
    };
    try {
      if (editing) {
        await patch.mutateAsync({
          id: provider.id,
          body: {
            ...shared,
            // Blank means keep; there is no "clear the secret" on the wire.
            ...(secret === "" ? {} : { clientSecret: secret }),
            allowedDomains: domains.trim(),
          },
        });
      } else {
        await create.mutateAsync({
          id: slug,
          kind,
          ...shared,
          clientSecret: secret,
          ...(domains.trim() === "" ? {} : { allowedDomains: domains.trim() }),
          enabled: true,
        });
      }
      onDone();
    } catch (err) {
      setSaveError(err);
    }
  }

  /** The refusal's server sentence, shown under the field or block it belongs to. */
  function errorText(codes: string[]): string | null {
    if (!(saveError instanceof ApiError) || !codes.includes(saveError.code ?? "")) return null;
    return errMessage(saveError, SAVE_ERROR_FALLBACK);
  }
  /** Anything no code-specific slot claimed. */
  const generalError =
    saveError !== null &&
    !(
      saveError instanceof ApiError &&
      ["DISCOVERY_FAILED", "SLUG_TAKEN", "LAST_SIGN_IN_DOOR"].includes(saveError.code ?? "")
    )
      ? errMessage(saveError, SAVE_ERROR_FALLBACK)
      : null;

  const saveDisabled =
    busy ||
    name.trim() === "" ||
    issuer.trim() === "" ||
    clientId.trim() === "" ||
    (!editing && (secret === "" || slug === "" || slug === EMAIL_PROVIDER_ID)) ||
    entries.length === 0;

  return (
    <div className="space-y-4">
      {/* One trust sentence for the whole dialog (§5's accounting, told at the
          act that makes it true). */}
      <p className="text-detail text-muted-foreground">
        A provider that asserts an email address links straight into the matching account. Add only issuers you trust.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label id="ap-kind-label">Provider kind</Label>
          <Select
            value={kind}
            // A created row's kind is immutable (the route refuses it too).
            // The Google preset seeds the issuer at rest and on switch-back,
            // and switching away clears ONLY the preset it wrote — a
            // hand-entered issuer is the admin's answer, not ours to retract.
            onValueChange={(v) => {
              if (v !== "google" && v !== "oidc") return;
              setKind(v);
              if (v === "google") {
                if (issuer === "" || issuer === GOOGLE_ISSUER) setIssuer(GOOGLE_ISSUER);
              } else if (issuer === GOOGLE_ISSUER) {
                setIssuer("");
              }
            }}
            disabled={editing}
            items={[
              { value: "google", label: "Google" },
              { value: "oidc", label: "Generic OIDC" },
            ]}
          >
            <SelectTrigger aria-labelledby="ap-kind-label" disabled={editing}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="oidc">Generic OIDC</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ap-name">Name</Label>
          <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Google" />
          {errorText(["SLUG_TAKEN"]) && (
            <p role="alert" className="text-destructive text-detail">
              {errorText(["SLUG_TAKEN"])}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ap-issuer">Issuer</Label>
        <Input
          id="ap-issuer"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          placeholder="https://id.example/"
        />
        <p className="text-detail text-muted-foreground">
          Discovery runs on save; the door is refused before it exists if the issuer answers nothing.
        </p>
        {errorText(["DISCOVERY_FAILED"]) && (
          <p role="alert" className="text-destructive text-detail">
            {errorText(["DISCOVERY_FAILED"])}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="ap-client">Client ID</Label>
          <Input id="ap-client" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ap-secret">Client secret</Label>
          <Input
            id="ap-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={editing ? "leave blank to keep" : "paste from your provider"}
          />
        </div>
      </div>

      <EntryPointsEditor entries={entries} setEntries={setEntries} candidates={candidates} />

      <RegistrationPanel entries={entries} providerId={displayId} />

      {/* The three door half-switches (spec §7), each with one or two
          sentences of help at `detail`. */}
      <div className="space-y-3">
        <div className="flex items-start gap-4">
          <Switch checked={signInEnabled} onCheckedChange={(c) => setSignInEnabled(c)} aria-label="Allow sign-in" />
          <div>
            <Label className="font-strong">Allow sign-in</Label>
            <p className="text-detail text-muted-foreground">
              Shows this door on the login page. Turning it off hides the button and refuses callbacks.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <Switch
            checked={registrationEnabled}
            onCheckedChange={(c) => setRegistrationEnabled(c)}
            aria-label="Allow account creation"
          />
          <div>
            <Label className="font-strong">Allow account creation</Label>
            <p className="text-detail text-muted-foreground">
              Lets this provider create accounts for people it has never seen. Off means only existing accounts can come
              through.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <Switch
            checked={requireApproval}
            onCheckedChange={(c) => setRequireApproval(c)}
            aria-label="Require approval"
          />
          <div>
            <Label className="font-strong">Require approval</Label>
            <p className="text-detail text-muted-foreground">
              New accounts from this door wait for an admin to approve them. People who already have accounts sign in
              normally.
            </p>
          </div>
        </div>
        {errorText(["LAST_SIGN_IN_DOOR"]) && (
          <p role="alert" className="text-destructive text-detail">
            {errorText(["LAST_SIGN_IN_DOOR"])}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="ap-domains">Allowed email domains</Label>
        <Input
          id="ap-domains"
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          placeholder="acme.com, other.example"
        />
        <p className="text-detail text-muted-foreground">
          Leave blank to admit any email domain. A listed domain also admits its subdomains.
        </p>
      </div>

      <div className="space-y-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-detail"
          disabled={issuer.trim() === "" || test.isPending}
          onClick={() =>
            void test.mutateAsync({
              issuer: issuer.trim(),
              ...(clientId.trim() === "" ? {} : { clientId: clientId.trim() }),
              ...(secret === "" ? {} : { clientSecret: secret }),
            })
          }
        >
          Verify credentials
        </Button>
        {test.data && (
          <p className="text-detail text-success">{test.data.note ?? "Discovery answered. The door can be saved."}</p>
        )}
        {test.error && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(test.error, "Verification failed.")}
          </p>
        )}
      </div>

      {generalError && (
        <p role="alert" className="text-destructive text-detail">
          {generalError}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saveDisabled}>
          {busy ? "Saving…" : editing ? "Save" : "Add provider"}
        </Button>
      </DialogFooter>
    </div>
  );
}
