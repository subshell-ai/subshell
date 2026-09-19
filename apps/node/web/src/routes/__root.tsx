import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute } from "@tanstack/react-router";
import { ConfirmProvider } from "@/components/confirm-dialog";
import { DashboardShell } from "@/components/dashboard-shell";
import { queryClient } from "@/lib/query-client";

export const Route = createRootRoute({
  component: RootComponent,
});

/**
 * The provider stack. There is no auth guard and no session — the dashboard is
 * a loopback surface the machine's own user drives, so everything below the
 * providers is unconditional chrome. The two providers are the two things the
 * shared cards assume the host app supplies: the query cache they read/write,
 * and the `confirmAction` handler the destructive verbs wait on.
 *
 * `DashboardShell` renders the `<Outlet/>` itself (top bar and nav wrap the
 * page), so the route tree's children mount inside the shell.
 */
function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <DashboardShell />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}
