import { Button } from "@internal/node-admin";
import { ErrorBanner } from "@/components/error-banner";
import { NetworkRow as NetworkRowItem } from "@/components/setup/network-row";
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
 * The SORT key, and nothing more: a network the machine already has is a
 * question a person can ANSWER right now, so it leads. It used to be a
 * GROUPING key, which put everything else behind an "Other networks"
 * disclosure — a heading relative to an empty group on every fresh install.
 * Unsupported and disabled rows count as not started — there is nothing to do
 * about either of them here.
 */
function hasStarted(row: NetworkRow): boolean {
  return row.supported && row.enabled && row.status !== undefined && row.status.state !== "not-installed";
}

/**
 * Whether this network is something the step has to CONTINUE with — the
 * predicate behind the wizard's primary-button label (operator's call,
 * 2026-09-18): a joined or published network on a plugin this platform
 * supports and the instance offers.
 *
 * Deliberately NARROWER than {@link hasStarted}, and the two must not be
 * collapsed: `hasStarted` is the SORT key — a daemon installed but signed out
 * leads the list because it is a question a person can answer right now —
 * while it is exactly NOT something to continue with. Nothing has been gained
 * yet that leaving the wizard would carry; the join is still ahead, and it
 * waits on `/settings/networking` like everything else here. A row counts
 * here only once it has addresses that could answer a sign-in.
 */
export function isNetworkUsable(row: NetworkRow): boolean {
  return row.supported && row.enabled && (row.status?.state === "joined" || row.status?.state === "published");
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
 * products. What `compact` changes is the frame — no card chrome, no header,
 * no description, no supervisor detail, only the settings a join cannot
 * proceed without — never the acts. Here it is what a row expands INTO: the
 * step itself shows one collapsed row per network, so nothing on screen asks
 * anything until a person presses Configure.
 *
 * Skipping is always available and costs nothing: every one of these acts is
 * on `/settings/networking` afterwards, and a first run that traps someone
 * behind a vendor's sign-in is worse than one that offered it.
 */
export function NetworkStep({ active }: { active: boolean }) {
  const { data, isLoading, isError, refetch } = useNetwork(active, active ? SETUP_POLL_MS : undefined);
  const networks = data?.networks ?? [];
  // Stable within each half, so the server's own id order survives: `sort` is
  // stable in every runtime this ships to, and the comparator answers 0 for
  // two rows on the same side.
  const rows = [...networks].sort((a, b) => Number(hasStarted(b)) - Number(hasStarted(a)));

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
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <NetworkRowItem key={row.id} row={row} />
          ))}
        </ul>
      )}
      {data !== undefined && networks.length === 0 && (
        <p className="text-muted-foreground text-sm">
          This build ships no network plugins. You can still reach this server at its own address.
        </p>
      )}
    </div>
  );
}
