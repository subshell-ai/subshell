import { CopyableValue, Label } from "@internal/node-admin";
import { callbackUrlFor } from "@/types/auth-provider";

/**
 * The registration-info panel (spec §5a), split out of `provider-dialog.tsx`
 * by review Minor 5, and cut to the operator's ruling of 2026-09-25: THE
 * ROWS ARE THE INSTRUCTIONS. The copy-all block restated the URIs the rows
 * already show, and the loopback blurb and the canonical-entry sentence
 * explained what the badge and the rows already say, so all three are gone.
 * What remains is one sentence of what to DO at the provider and one row
 * pair per entry point. The dialog's own order follows the provider's
 * sequence: register these values first, and the client ID and secret that
 * come back are the fields UNDER this panel.
 *
 * It renders whenever there are entries, NOT only once the id exists: a
 * fresh dialog showed nothing at all before, which read as the instructions
 * being missing entirely (the operator's report). The URI rows are the half
 * that genuinely needs the slug, so they wait for the name and say so; the
 * JavaScript origins are known from the first paint.
 *
 * `providerId` is the id that WILL be stored (the dialog sends its own slug
 * preview on create), so what the panel showed is byte-identically what gets
 * stored. The redirect itself always goes to the canonical entry on
 * better-auth 1.7.1 (final review, Important 3; spec §5a amendment,
 * `pickEntryOrigin`'s server pin); that row is FIRST here because it is
 * first in the list, and the badge that names it lives on the entry-point
 * editor above — the operator's ruling 2026-09-25 took it out of this panel,
 * where one per entry said what the order already says.
 */
export function RegistrationPanel({ entries, providerId }: { entries: readonly string[]; providerId: string }) {
  if (entries.length === 0) return null;
  const named = providerId !== "";
  return (
    // `pt-0`: a LEGEND straddles the fieldset's border, so half its line
    // already hangs inside the box — a full top padding stacked on that is
    // the gap the operator flagged (2026-09-25). The other sides keep p-3.
    <fieldset className="space-y-3 rounded-md border px-3 pt-0 pb-3">
      <legend className="font-strong text-label">Finish the setup at your provider</legend>
      <p className="text-detail text-muted-foreground">
        Create one web-application OIDC client with your provider and register every value below. The client ID and
        secret it gives you are the two fields underneath.
      </p>
      {/* Grouped by FIELD, not by entry, and in the ORDER the provider's own
          form goes (operator ask 2026-09-25): Google's credential screen
          asks for Authorized JavaScript origins first, then Redirect URIs,
          so the panel reads the same way and nothing has to be re-ordered
          in the admin's head. Each header once, its values listed under it;
          font-mono because these strings are pasted. */}
      <div className="space-y-4">
        <div className="space-y-1">
          <Label className="text-detail">JavaScript origin</Label>
          <ul className="list-disc space-y-1 pl-4 font-mono text-detail">
            {entries.map((origin) => (
              <li key={origin}>
                <CopyableValue value={origin} label="JavaScript origin" />
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-1">
          <Label className="text-detail">Redirect URI</Label>
          {named ? (
            <ul className="list-disc space-y-1 pl-4 font-mono text-detail">
              {entries.map((origin) => (
                <li key={origin}>
                  <CopyableValue value={callbackUrlFor(origin, providerId)} label="Redirect URI" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-detail text-muted-foreground">Appears once you name the provider.</p>
          )}
        </div>
      </div>
    </fieldset>
  );
}
