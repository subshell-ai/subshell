import { createFileRoute } from "@tanstack/react-router";
import { ConnectPanel } from "@/components/connect/connect-panel";
import { PageHeader } from "@/components/page-header";

/**
 * The SSH launcher (spec 2026-10-07 §7): the destination-first page the top-
 * level Connect nav entry lands on. The route carries no search params - the
 * panel is one act, not a view over data; the ledger lives in the panel's
 * own queries. All the flow lives in `components/connect/`.
 */
export const Route = createFileRoute("/connect")({
  component: ConnectPage,
});

// Exported for the route test (the composition pin); the router reads it
// through `Route`, no other caller should.
export function ConnectPage() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <PageHeader title="Connect" subtitle="Open an SSH pane from one of your machines." />
      <ConnectPanel />
    </main>
  );
}
