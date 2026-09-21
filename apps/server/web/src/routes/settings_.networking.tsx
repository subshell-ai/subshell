import { Button, Card, CardContent, CardHeader, CardTitle } from "@internal/node-admin";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { AddNetworkCard } from "@/components/networking/add-network-card";
import { AddressesCard } from "@/components/networking/addresses-card";
import { PageHeader } from "@/components/page-header";
import { NetworkRow as NetworkRowItem } from "@/components/setup/network-row";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { NETWORK_MUTATION_KEY, NETWORK_QUERY_KEY, useNetwork } from "@/hooks/use-network";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment } from "@/hooks/use-server-deployment";
import { useServerRestart } from "@/hooks/use-server-restart";
import type { NetworkList, NetworkRow } from "@/types/network";

export const Route = createFileRoute("/settings_/networking")({ component: NetworkingPage });

/** At rest: nothing on this page changes unless somebody changes it. */
const IDLE_POLL_MS = 30_000;

/**
 * While something is happening: an act in flight, or a sign-in the person is
 * finishing in another tab.
 *
 * The interactive sign-in is the case that sets this number. The vendor tells
 * the DAEMON that the sign-in landed — never this browser — so polling is the
 * only way this page learns, and a person who has just clicked "Authorize" is
 * looking straight at it.
 */
const ACTIVE_POLL_MS = 5_000;

/**
 * True while any row is waiting on a sign-in the page cannot be told about.
 *
 * Keyed on `loginUrl`, NOT on the `needs-login` state. That state is the
 * RESTING state of any installed, running, unjoined network — an admin who
 * opens this page with Tailscale installed and not signed in would otherwise
 * have this server run `tailscale status --json` every five seconds for as
 * long as the tab stayed open, for a row nobody is acting on. Only an
 * interactive login that has actually started produces a URL, and that is the
 * one case where the answer arrives out of band and polling is the only way to
 * see it.
 */
export function awaitingLogin(networks: NetworkRow[] | undefined): boolean {
  return (networks ?? []).some((row) => row.status?.loginUrl !== undefined);
}

/**
 * Server Settings → Networking: reaching this server from the operator's
 * other devices.
 *
 * The admin gate is the one `/settings/status` established and
 * `/settings/service` copies: `viewerIsAdmin` comes from the server,
 * `undefined` counts as NOT admin, and the read is `enabled`-gated on it so a
 * member's mount fires no doomed 403. The Retry lives inside the admin branch
 * for the same reason — `refetch()` ignores `enabled` and would fire exactly
 * that.
 *
 * There is no Refresh button and no per-card Re-check: the page polls, and a
 * control offering to do what it already does every few seconds reads as a
 * page that does not. The cards carried a Re-check in every setup state until
 * the operator's sixth live read (2026-09-16) cut it for exactly this reason;
 * the poll cadences are what they were, and the plugin hints now say the page
 * notices, rather than ordering a press that no longer exists.
 */
function NetworkingPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  // Any network act, from any card on this page. The cards own their own
  // mutations — a card is the thing acting — so this is how the page hears
  // about them without every card reporting upwards.
  const acting = useIsMutating({ mutationKey: NETWORK_MUTATION_KEY }) > 0;
  // The cadence depends on the answer, and the answer is what this call is
  // for — so the decision reads the CACHE, one render behind. That lag is
  // exactly one render and it costs a single poll at the old rate: this
  // component subscribes to the same key, so the render that delivers a row
  // in `needs-login` is also the render that reads it back here.
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<NetworkList>(NETWORK_QUERY_KEY);
  const { data, error, isLoading, refetch } = useNetwork(
    isAdmin,
    acting || awaitingLogin(cached?.networks) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  );
  // One consumer now that the Addresses card moved here from
  // `/settings/service` on 2026-09-17: where this server listens and which
  // addresses a browser may use is the same question the page answers, asked
  // of config.env. 60 s, not this hook's 5 s default, for the
  // `/settings/status` Locations card's reason: every read of
  // `/api/admin/server` runs the service-manager and port probes
  // synchronously. The card writing config.env from here does not change the
  // cadence: a save writes the fresh view into the cache itself, so the poll
  // only ever catches up with an edit made over ssh. (The 'what am I
  // addressed as' line this read used to feed is gone — the card states the
  // value, its saved-vs-running half included.)
  const deployment = useServerDeployment(isAdmin, 60_000);
  // The restart press + wait the Addresses card offers: press, 202, wait
  // for the new boot. `useAdminStatus` supplies the `bootedAt` baseline the
  // waiter compares against — mounted here for the same reason
  // `/settings/service` mounts it for its own restart cards (those did NOT
  // move, so this is a second mount of one admin read; the shared cache and
  // per-observer intervals are what make that cheap). Without the baseline
  // the first answer after the press would count as "back" whatever it was.
  const restart = useServerRestart();
  useAdminStatus(isAdmin);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Networking" subtitle="Reach this server from your other devices." />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          {error && (
            <ErrorBanner
              message="Could not load this server's networks."
              className="rounded-md border"
              action={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-detail text-inherit underline"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              }
            />
          )}
          {isLoading && !data && <p className="text-muted-foreground text-sm">Loading…</p>}
          {/* Where the server listens and which addresses a browser may use,
              moved from `/settings/service` on 2026-09-17: this page's whole
              subject is reaching this server, and the base URL and origin
              list are that subject's config.env half — the Networks card
              below is the live half. It leads because you join a network to
              reach an address, not the other way round. The one-line "This
              server's address" summary that used to sit above it is GONE:
              the card states the value in its field, the saved-vs-running
              line beside it, and each network's own addresses inside its
              expanded card — the line restated all three. */}
          {deployment.data && <AddressesCard view={deployment.data} restart={restart} />}
          {/* One card grouping the networks, so the page reads as two
              sections — the addresses this server has, and the networks that
              give it more. Inside, collapsed rows as in the wizard's Network
              step: the row says WHO is here (name, state chip) and Configure
              opens the card body in place; the difference is only what
              expands — here the whole card, fields and supervisor detail
              included. */}
          {/* `role="region"` because the old per-network cards each exposed
              a named landmark; a bare div inside one unnamed card would be
              a downgrade for a screen reader moving between networks. */}
          <Card role="region" aria-label="Installed networks">
            <CardHeader>
              <CardTitle>Networks</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {/* Rendered on the unanswered read too: the page's error
                  statement lives inside this card now, and a card that
                  carried a failure on the Service page but loses it here
                  would move the form and drop the honesty. */}
              {deployment.error && (
                <div className="mb-4 space-y-2">
                  <p className="text-destructive text-detail">The server addresses could not be loaded.</p>
                  <Button variant="outline" size="sm" onClick={() => void deployment.refetch()}>
                    Retry
                  </Button>
                </div>
              )}
              {data && data.networks.length > 0 ? (
                <ul>
                  {data.networks.map((row) => (
                    <NetworkRowItem key={row.id} row={row} body="full" />
                  ))}
                </ul>
              ) : data ? (
                // Only once the networks read ANSWERED: while it is in
                // flight the card waits rather than declaring "nothing
                // installed" about a list that may be about to arrive.
                <p className="text-detail text-muted-foreground">
                  No networks installed yet. Add one below to reach this server over a VPN or tunnel.
                </p>
              ) : null}
            </CardContent>
          </Card>
          <AddNetworkCard />
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Networking is for instance admins; your settings live under{" "}
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
