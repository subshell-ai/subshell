import { ApiError, Badge, Button, CopyableValue, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateAuthProvider, usePatchAuthProvider, useTestAuthProvider } from "@/hooks/use-auth-providers";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { isLoopbackUrl } from "@/lib/loopback";
import {
  callbackUrlFor,
  EMAIL_PROVIDER_ID,
  GOOGLE_ISSUER,
  type ProviderAdminView,
  previewProviderId,
} from "@/types/auth-provider";

/** The Select's escape hatch: a free-typed address the registry has not learned. */
const OTHER = "__other__";

/**
 * Bare-origin validation for an entry point (spec §5a): http(s) scheme, a host,
 * no path/query/fragment/credentials, wildcards refused — the component-wise
 * trusted-origin rule, minus wildcards, mirrored here so a bad paste is caught
 * at the form. Returns the canonical `URL.origin` spelling or null; the route
 * validates again (the server is the boundary, this is the courtesy).
 */
export function normalizeOriginEntry(raw: string): string | null {
  const s = raw.trim();
  if (!s || /[*?\s]/.test(s) || s.includes("@")) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.pathname !== "" && u.pathname !== "/") return null;
    if (u.search || u.hash) return null;
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * The addresses to OFFER as entry points, best first: this browser's, then
 * `appBaseUrl`, then the trusted-origin list, deduped to canonical origins.
 * The same three sources the Add-node and mobile pickers merge
 * (`lib/install-addresses`), with that helper's loopback DROP undone on
 * purpose: this picker is for the round trips of browsers ON THIS plane, and
 * a fresh instance's only address is loopback (spec §5a). An unparseable
 * entry is dropped rather than rendered, exactly as there.
 */
export function entryOriginCandidates(sources: {
  here: string;
  baseUrl: string | undefined;
  trustedOrigins: string[] | undefined;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    const origin = raw ? normalizeOriginEntry(raw) : null;
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    out.push(origin);
  };
  add(sources.here);
  add(sources.baseUrl);
  for (const origin of sources.trustedOrigins ?? []) add(origin);
  return out;
}

/** Per-entry lines of the copy-all block, in the order an IdP form wants them. */
function registrationBlock(entries: readonly string[], id: string): string {
  const uris = entries.map((origin) => callbackUrlFor(origin, id));
  return `Redirect URIs:\n${uris.join("\n")}\n\nAuthorized JavaScript origins:\n${entries.join("\n")}`;
}

/**
 * The add/edit dialog for one OIDC door (spec §7). The email row never opens
 * it: its kind and id are fixed and it has nothing to register, so the table
 * toggles are its whole surface.
 *
 * The form lives BELOW `DialogContent` and keys off the provider id, so every
 * open starts from the row it was opened on (Base UI unmounts hidden content;
 * a form living in `ProviderDialog` itself would carry the previous row's
 * half-typed issuer across closes).
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

  const [kind, setKind] = useState<"google" | "oidc">(provider && provider.kind !== "email" ? provider.kind : "google");
  const [name, setName] = useState(provider?.name ?? "");
  const [issuer, setIssuer] = useState(provider?.issuer ?? "");
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  // Edit starts BLANK: the list never carries the secret (§8), and a blank
  // save means "leave stored" — explicit clearing does not exist server-side.
  const [secret, setSecret] = useState("");
  const [entries, setEntries] = useState<string[]>(provider?.entryOrigins ?? []);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
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
  const offered = [...candidates.filter((c) => !entries.includes(c)), OTHER];
  const selected = offered.find((c) => c === candidate) ?? offered[0];

  function addEntry(): void {
    setEntryError(null);
    const raw = selected === OTHER ? otherText : selected;
    const origin = normalizeOriginEntry(raw ?? "");
    if (!origin) {
      setEntryError("Enter a full http(s) address with no path, like https://plane.example.");
      return;
    }
    if (!entries.includes(origin)) setEntries((prev) => [...prev, origin]);
    setOtherText("");
  }

  function move(index: number, delta: -1 | 1): void {
    setEntries((prev) => {
      const next = [...prev];
      const to = index + delta;
      const moved = next[index];
      if (to < 0 || to >= next.length || moved === undefined) return prev;
      next[index] = next[to] as string;
      next[to] = moved;
      return next;
    });
  }

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
    return errMessage(saveError, "Couldn't save the provider.");
  }
  /** Anything no code-specific slot claimed. */
  const generalError =
    saveError !== null &&
    !(
      saveError instanceof ApiError &&
      ["DISCOVERY_FAILED", "SLUG_TAKEN", "LAST_SIGN_IN_DOOR"].includes(saveError.code ?? "")
    )
      ? errMessage(saveError, "Couldn't save the provider.")
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
            // A created row's kind is immutable (the route refuses it too);
            // Google's preset only makes sense at the first keystrokes.
            onValueChange={(v) => {
              if (v !== "google" && v !== "oidc") return;
              setKind(v);
              if (v === "google" && (issuer === "" || issuer === GOOGLE_ISSUER)) setIssuer(GOOGLE_ISSUER);
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

      {/* Entry points (spec §5a): a list editor over the live origin registry
          plus a typed escape. Order matters and is shown: position 1 is the
          canonical fallback the round trip lands on when the visitor's host is
          not on the list. */}
      <div className="space-y-2">
        <Label>Entry points</Label>
        <p className="text-detail text-muted-foreground">
          The addresses people will sign in from. Each one needs its callback registered at the provider.
        </p>
        <ul className="space-y-1">
          {entries.map((origin, i) => (
            <li key={origin} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-detail">{origin}</span>
              {i === 0 && <Badge variant="secondary">Canonical</Badge>}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${origin} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${origin} down`}
                disabled={i === entries.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${origin}`}
                onClick={() => setEntries((prev) => prev.filter((o) => o !== origin))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
          {entries.length === 0 && <li className="text-detail text-muted-foreground">No entry points yet.</li>}
        </ul>
        <div className="flex items-start gap-2">
          <Select
            value={selected ?? null}
            onValueChange={(v) => {
              if (typeof v === "string") setCandidate(v);
            }}
            items={offered.map((o) => ({ value: o, label: o === OTHER ? "Other…" : o }))}
          >
            <SelectTrigger aria-label="Address to add" className="min-w-0 flex-1">
              <SelectValue placeholder="Choose an address" />
            </SelectTrigger>
            <SelectContent>
              {offered.map((o) => (
                <SelectItem key={o} value={o}>
                  <span className="truncate">{o === OTHER ? "Other…" : o}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" onClick={addEntry} disabled={offered.length === 1}>
            Add
          </Button>
        </div>
        {selected === OTHER && (
          <Input
            aria-label="Other address"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="https://still-learning.example"
          />
        )}
        {entryError && (
          <p role="alert" className="text-destructive text-detail">
            {entryError}
          </p>
        )}
      </div>

      {/* The registration-info copy panel (§5a): the whole list in one pass,
          per entry the two strings Google-style IdPs ask for by name. */}
      {entries.length > 0 && displayId !== "" && (
        <fieldset className="space-y-3 rounded-md border p-3">
          <legend className="font-strong text-label">Finish the setup at your provider</legend>
          <p className="text-detail text-muted-foreground">
            Register each redirect URI and JavaScript origin at the provider. A host missing from its list cannot
            complete its sign-in round trip.
          </p>
          <div className="space-y-3">
            {entries.map((origin, i) => (
              <div key={origin} className="space-y-1">
                {i === 0 && <Badge variant="secondary">Canonical fallback</Badge>}
                <div className="flex items-baseline gap-2">
                  <Label className="w-40 shrink-0 text-detail">Redirect URI</Label>
                  <CopyableValue value={callbackUrlFor(origin, displayId)} label="Redirect URI" />
                </div>
                <div className="flex items-baseline gap-2">
                  <Label className="w-40 shrink-0 text-detail">JavaScript origin</Label>
                  <CopyableValue value={origin} label="JavaScript origin" />
                </div>
              </div>
            ))}
          </div>
          <CopyCommandRow text={registrationBlock(entries, displayId)} label="registration block" />
          {entries.some((origin) => isLoopbackUrl(origin)) && (
            <p className="text-detail text-muted-foreground">
              Google accepts http://localhost redirect URIs for development. Set APP_BASE_URL to your public https
              address before registering production apps.
            </p>
          )}
        </fieldset>
      )}

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
