import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { AddNetworkCard } from "@/components/networking/add-network-card";
import { NetworkPluginCard } from "@/components/networking/network-plugin-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { NETWORK_MUTATION_KEY, NETWORK_QUERY_KEY, useNetwork } from "@/hooks/use-network";
import { usePublicSettings } from "@/hooks/use-public-settings";
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

/** True while any row is waiting on a sign-in the page cannot be told about. */
function awaitingLogin(networks: NetworkRow[] | undefined): boolean {
  return (networks ?? []).some((row) => row.status?.state === "needs-login");
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
 * There is no Refresh button: the page polls, and a control offering to do
 * what it already does every few seconds reads as a page that does not.
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
          {data?.networks.map((row) => (
            <NetworkPluginCard key={row.id} row={row} />
          ))}
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
