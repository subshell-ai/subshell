import { ErrorBanner } from "@/components/error-banner";
import { NetworkPluginCard } from "@/components/networking/network-plugin-card";
import { Button } from "@/components/ui/button";
import { useNetwork } from "@/hooks/use-network";
import type { NetworkRow } from "@/types/network";

/**
 * How fast the first-run step polls.
 *
 * Faster than the settings page's active cadence, because this screen has a
 * person standing in front of it who has just been sent to a vendor's site to
 * authorize a machine. The vendor tells the DAEMON, never this browser, so the
 * only way back is asking.
 */
const SETUP_POLL_MS = 4000;

/**
 * Whether this network has got past "nothing is installed" on this host.
 *
 * The split it drives is the whole layout of this screen: a network the
 * machine already has is a question a person can ANSWER right now, and one
 * they would have to go and install first is a decision for a quieter moment.
 * Unsupported and disabled rows count as not started — there is nothing to do
 * about either of them here.
 */
function hasStarted(row: NetworkRow): boolean {
  return row.supported && row.enabled && row.status !== undefined && row.status.state !== "not-installed";
}

/**
 * The wizard's Network step (optional, second): reaching this server from the
 * devices a person actually uses.
 *
 * It exists because the answer a fresh install gives to "open this on your
 * phone" is otherwise a 403 on sign-in, from a page naming nothing that could
 * be changed — the trusted-origins trap `/settings/service` documents. The
 * moment to fix that is before anyone has typed an address into a phone, not
 * after.
 *
 * **It reuses `NetworkPluginCard` rather than reimplementing the states.** A
 * person meets these two surfaces minutes apart, and a wizard that answered
 * "what can I do from here" differently from the settings page would be two
 * products. What `compact` changes is the frame — no card chrome, no
 * description, no supervisor detail, only the settings a join cannot proceed
 * without — never the acts.
 *
 * Skipping is always available and costs nothing: every one of these acts is
 * on `/settings/networking` afterwards, and a first run that traps someone
 * behind a vendor's sign-in is worse than one that offered it.
 */
export function NetworkStep({ active }: { active: boolean }) {
  const { data, isLoading, isError, refetch } = useNetwork(active, active ? SETUP_POLL_MS : undefined);
  const networks = data?.networks ?? [];
  const started = networks.filter(hasStarted);
  const others = networks.filter((row) => !hasStarted(row));

  return (
    <div className="space-y-4">
      {isLoading && !data && <p className="text-muted-foreground text-sm">Checking this machine…</p>}
      {isError && (
        <ErrorBanner
          message="Couldn't check which networks this machine has."
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
      {started.length > 0 && (
        <ul className="space-y-3">
          {started.map((row) => (
            <NetworkPluginCard key={row.id} row={row} compact />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        // A disclosure, not a second list: these are the ones asking the
        // person to go and install something, which is not the shape of a
        // step they are meant to finish in a minute. Open by default when
        // there is nothing else, because then it is the only answer there is.
        <details open={started.length === 0}>
          <summary className="cursor-pointer text-detail text-muted-foreground">Other networks</summary>
          <ul className="mt-3 space-y-3">
            {others.map((row) => (
              <NetworkPluginCard key={row.id} row={row} compact />
            ))}
          </ul>
        </details>
      )}
      {data !== undefined && networks.length === 0 && (
        <p className="text-muted-foreground text-sm">
          This build ships no network plugins. You can still reach this server at its own address.
        </p>
      )}
    </div>
  );
}
