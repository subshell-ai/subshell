import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { SystemApiKeysCard } from "@/components/system-api-keys-card";
import { usePublicSettings } from "@/hooks/use-public-settings";

export const Route = createFileRoute("/settings_/api-keys")({ component: ApiKeysPage });

/**
 * The system API keys page (spec 2026-09-11 §4.3) — one card, off the
 * `/settings` scroll and onto a page the rail can name.
 *
 * The card keeps its own title even though the header says the same thing:
 * it is reused nowhere else, and its `CardTitle` is what its tests and its
 * copy refer to. The admin gate is `/settings`'s — server-derived
 * `viewerIsAdmin`, `undefined` counting as NOT admin, so a member's mount
 * fires no doomed 403 against the admin-only keys endpoint.
 */
function ApiKeysPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* Not the card's own description repeated — see the note on
          `/settings/audit` for why one sentence twice is both a visual bug
          and an ambiguous test locator. */}
      <PageHeader title="API keys" subtitle="Machine credentials for tooling that talks to this instance (admins)" />
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <SystemApiKeysCard />
      ) : (
        <p className="text-muted-foreground text-sm">
          Instance settings are for admins. Your settings live under{" "}
          <Link to="/preferences" className="underline">
            Preferences
          </Link>{" "}
          and{" "}
          <Link to="/account" className="underline">
            Account settings
          </Link>
          .
        </p>
      )}
    </main>
  );
}
