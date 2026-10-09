import { createFileRoute } from "@tanstack/react-router";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { PageHeader } from "@/components/page-header";
import { sshConnectSearch } from "@/lib/ssh-connect-search";

/**
 * The SSH launcher (spec 2026-10-07 §7): the destination-first page the top-
 * level Connect nav entry lands on. Search params preserve connection choices
 * across an approval round trip; they prefill fields but never launch.
 * The ledger and flow live in `components/connect/`.
 */
export const Route = createFileRoute("/connect")({
  validateSearch: sshConnectSearch,
  component: ConnectRoute,
});

// Exported for the route test (the composition pin); the router reads it
// through `Route`, no other caller should.
function ConnectRoute() {
  const initial = Route.useSearch();
  return <ConnectPage initial={initial} />;
}

export function ConnectPage({ initial }: { initial?: ReturnType<typeof sshConnectSearch> } = {}) {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <PageHeader title="Connect" subtitle="Open an SSH pane from one of your machines." />
      <ConnectPanel initial={initial} />
    </main>
  );
}
