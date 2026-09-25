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
 * The registration-info panel (spec §5a), split out of `provider-dialog.tsx`
 * by review Minor 5, and reworded on the operator's ask of 2026-09-25: the
 * block LEADS with what to DO at the provider (create a web-application OIDC
 * client, register these values, paste the returned pair back), because an
 * admin holding an unregistered app has no way to map these strings to the
 * IdP form in front of them.
 *
 * It renders whenever there are entries, NOT only once the id exists: a
 * fresh dialog showed nothing at all before, which read as the instructions
 * being missing entirely (the operator's report). The URI rows are the half
 * that genuinely needs the slug, so they wait for the name and say so; the
 * JavaScript origins are known from the first paint.
 *
 * `providerId` is the id that WILL be stored (the dialog sends its own slug
 * preview on create), so what the panel showed is byte-identically what gets
 * stored. The per-entry sentence describes the SHIPPED behavior (final
 * review, Important 3): on better-auth 1.7.1 the redirect is always the
 * canonical entry — see the spec's §5a amendment and `pickEntryOrigin`'s pin
 * in the server.
 */
export function RegistrationPanel({ entries, providerId }: { entries: readonly string[]; providerId: string }) {
  if (entries.length === 0) return null;
  const named = providerId !== "";
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="font-strong text-label">Finish the setup at your provider</legend>
      <p className="text-detail text-muted-foreground">
        Create one web-application OIDC client with your provider and register every value below. Then paste the client
        ID and secret it gives you back into the fields above.
      </p>
      <div className="space-y-3">
        {entries.map((origin, i) => (
          <div key={origin} className="space-y-1">
            {i === 0 && <Badge variant="secondary">Canonical fallback</Badge>}
            <div className="flex items-baseline gap-2">
              <Label className="w-40 shrink-0 text-detail">Redirect URI</Label>
              {named ? (
                <CopyableValue value={callbackUrlFor(origin, providerId)} label="Redirect URI" />
              ) : (
                <span className="text-detail text-muted-foreground">Appears once you name the door.</span>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <Label className="w-40 shrink-0 text-detail">JavaScript origin</Label>
              <CopyableValue value={origin} label="JavaScript origin" />
            </div>
            {i === 0 && (
              <p className="text-detail text-muted-foreground">
                {entries.length === 1
                  ? "Every round trip lands on the canonical entry."
                  : "Round trips land on the canonical entry. The other entries register the door with your provider so each host stands ready."}
              </p>
            )}
          </div>
        ))}
      </div>
      {named && <CopyCommandRow text={registrationBlock(entries, providerId)} label="registration block" />}
      {entries.some((origin) => isLoopbackUrl(origin)) && (
        <p className="text-detail text-muted-foreground">
          Google accepts http://localhost redirect URIs for development. Set APP_BASE_URL to your public https address
          before registering production apps.
        </p>
      )}
    </fieldset>
  );
}
