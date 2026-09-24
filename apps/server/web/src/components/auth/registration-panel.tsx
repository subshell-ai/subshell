import { Badge, CopyableValue, Label } from "@internal/node-admin";
import { CopyCommandRow } from "@/components/copy-command-row";
import { isLoopbackUrl } from "@/lib/loopback";
import { callbackUrlFor } from "@/types/auth-provider";

/** Per-entry lines of the copy-all block, in the order an IdP form wants them. */
function registrationBlock(entries: readonly string[], id: string): string {
  const uris = entries.map((origin) => callbackUrlFor(origin, id));
  return `Redirect URIs:\n${uris.join("\n")}\n\nAuthorized JavaScript origins:\n${entries.join("\n")}`;
}

/**
 * The registration-info copy panel (spec §5a), split out of
 * `provider-dialog.tsx` by review Minor 5: the whole entry list in one pass,
 * per entry the two strings Google-style IdPs ask for by name. Shown live
 * while filling — `providerId` is the id that WILL be stored (the dialog
 * sends its own slug preview on create), so what the panel showed is
 * byte-identically what gets stored.
 */
export function RegistrationPanel({ entries, providerId }: { entries: readonly string[]; providerId: string }) {
  if (entries.length === 0 || providerId === "") return null;
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="font-strong text-label">Finish the setup at your provider</legend>
      <p className="text-detail text-muted-foreground">
        Register each redirect URI and JavaScript origin at the provider. A host missing from its list cannot complete
        its sign-in round trip, and removing an entry here breaks that host's door until the provider registration is
        updated.
      </p>
      <div className="space-y-3">
        {entries.map((origin, i) => (
          <div key={origin} className="space-y-1">
            {i === 0 && <Badge variant="secondary">Canonical fallback</Badge>}
            <div className="flex items-baseline gap-2">
              <Label className="w-40 shrink-0 text-detail">Redirect URI</Label>
              <CopyableValue value={callbackUrlFor(origin, providerId)} label="Redirect URI" />
            </div>
            <div className="flex items-baseline gap-2">
              <Label className="w-40 shrink-0 text-detail">JavaScript origin</Label>
              <CopyableValue value={origin} label="JavaScript origin" />
            </div>
          </div>
        ))}
      </div>
      <CopyCommandRow text={registrationBlock(entries, providerId)} label="registration block" />
      {entries.some((origin) => isLoopbackUrl(origin)) && (
        <p className="text-detail text-muted-foreground">
          Google accepts http://localhost redirect URIs for development. Set APP_BASE_URL to your public https address
          before registering production apps.
        </p>
      )}
    </fieldset>
  );
}
