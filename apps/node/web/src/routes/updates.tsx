import { createFileRoute } from "@tanstack/react-router";
import { UpdatesCard } from "@/components/updates-card";

export const Route = createFileRoute("/updates")({ component: UpdatesPage });

/**
 * Updates — this machine keeping itself current, with no plane in the loop.
 *
 * The control plane's Settings → Updates drives every component from one page;
 * this is the node acting only on itself, which is the case that matters when
 * the machine is headless or its plane is unreachable. One card, because there
 * is one thing here to update.
 */
function UpdatesPage() {
  return <UpdatesCard />;
}
