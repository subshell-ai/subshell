import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { AddNetworkCard } from "@/components/networking/add-network-card";
import { AddressesCard } from "@/components/networking/addresses-card";
import { PageHeader } from "@/components/page-header";
import { NetworkRow as NetworkRowItem } from "@/components/setup/network-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { NETWORK_MUTATION_KEY, NETWORK_QUERY_KEY, useNetwork } from "@/hooks/use-network";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment } from "@/hooks/use-server-deployment";
import { useServerRestart } from "@/hooks/use-server-restart";
import { baseUrlLine } from "@/lib/network-base-url";
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
  // Two consumers: the 'what am I addressed as' line (the base URL's SAVED
  // value) and the Addresses card, which moved here from `/settings/service`
  // on 2026-09-17 — where this server listens and which addresses a browser
  // may use is the same question the page answers, asked of config.env.
  // 60 s, not this hook's 5 s default, for the `/settings/status` Locations
  // card's reason: every read of `/api/admin/server` runs the service-manager
  // and port probes synchronously. The card writing config.env from here does
  // not change the cadence: a save writes the fresh view into the cache
  // itself, so the poll only ever catches up with an edit made over ssh.
  const deployment = useServerDeployment(isAdmin, 60_000);
  // The Addresses card's restart half: press, 202, wait for the new boot.
  // `useAdminStatus` supplies the `bootedAt` baseline the waiter compares
  // against — the same reason `/settings/service` mounts it; without it the
  // first answer after the press would count as "back" whatever it was.
  const restart = useServerRestart();
  useAdminStatus(isAdmin);
  // `settings?.` because a server older than the view sends `{}` where the
  // type says a full record — this page must degrade to no pending half, not
  // to a crash, exactly the rule `use-public-settings` follows.
  const base = baseUrlLine(
    publicSettings?.appBaseUrl,
    deployment.data?.settings?.APP_BASE_URL?.saved,
    data?.networks ?? [],
  );

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
          {/* Where this server says it lives, and which network's address
              that is — printed once, above the fields that write it. A saved
              change names itself as pending rather than pretending the
              boot-time constant has moved: `APP_BASE_URL` is still read at
              boot, even though the allowlist no longer is. */}
          {base && (
            <p className="text-detail text-muted-foreground">
              This server's address: <span className="font-mono">{base.running}</span>
              {base.runningOn ? ` — over ${base.runningOn}` : ""}.
              {base.pending !== null && (
                <>
                  {" "}
                  Saved for the next restart: <span className="font-mono">{base.pending}</span>
                  {base.pendingOn ? ` — over ${base.pendingOn}` : ""}.
                </>
              )}
            </p>
          )}
          {/* Where the server listens and which addresses a browser may use,
              moved from `/settings/service` on 2026-09-17: this page's whole
              subject is reaching this server, and the base URL and origin
              list are that subject's config.env half — the Networks card
              below is the live half. It leads because you join a network to
              reach an address, not the other way round. */}
          {deployment.data && <AddressesCard view={deployment.data} restart={restart} />}
          {/* One card grouping the networks, so the page reads as two
              sections — the addresses this server has, and the networks that
              give it more. Inside, collapsed rows as in the wizard's Network
              step: the row says WHO is here (name, state chip) and Configure
              opens the card body in place; the difference is only what
              expands — here the whole card, fields and supervisor detail
              included. */}
          {data && data.networks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Networks</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ul>
                  {data.networks.map((row) => (
                    <NetworkRowItem key={row.id} row={row} body="full" />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
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
