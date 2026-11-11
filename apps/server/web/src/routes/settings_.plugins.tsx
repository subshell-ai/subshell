import { Button, errMessage } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DashboardPage } from "@/components/dashboard-page";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { InstallByNameForm } from "@/components/plugins/install-by-name-form";
import { InstalledPluginsCard } from "@/components/plugins/installed-plugins-card";
import { PluginCatalogCard } from "@/components/plugins/plugin-catalog-card";
import { PluginRestartOffer } from "@/components/plugins/plugin-restart-offer";
import { UninstallPluginDialog } from "@/components/plugins/uninstall-plugin-dialog";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { INSTANCE_PLUGINS_QUERY_KEY, type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useCheckPluginUpdates, usePluginUpdates } from "@/hooks/use-plugin-updates";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment } from "@/hooks/use-server-deployment";
import { useServerRestart } from "@/hooks/use-server-restart";
import { PLUGIN_UPDATES_QUERY_KEY } from "@/lib/query-keys";

export const Route = createFileRoute("/settings_/plugins")({ component: InstancePluginsPage });

/**
 * The instance plugins page (spec 2026-09-10 §6): the one place plugins are
 * installed, disabled and uninstalled instance-wide. `<dataDir>/plugins/` on
 * THIS machine is the single plugin store now, so the per-node plugin card
 * gave its job to this page: one install arms every node, and installing runs
 * third-party code in the process that holds the node signing keypair.
 *
 * The admin gate follows `settings_.status.tsx` with one deliberate
 * difference, and the difference is the route table: GET /api/plugins is open
 * to every authenticated actor (the launch pickers read against it), so the
 * LIST renders for everyone and only the WRITE controls check
 * `viewerIsAdmin` — which comes from the server, where `undefined` (still
 * loading) is NOT admin, so a non-admin never fires a doomed 403.
 *
 * The restart offer below is the one ADMIN-only read on the page that is not
 * a plugin query: replacing bytes in the store does not replace code this
 * process imported at boot, so an updated row reports `restartRequired` until
 * the server has restarted. The deployment view says whether this machine can
 * restart itself, `admin/status` supplies the `bootedAt` baseline the waiter
 * compares against, and the offer is mounted only for a confirmed admin — the
 * same gate as the write controls.
 */
function InstancePluginsPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const canManage = viewerIsAdmin === true;
  const { data, error, isLoading, refetch } = useInstancePlugins();
  const updates = usePluginUpdates(canManage);
  const check = useCheckPluginUpdates();
  const deployment = useServerDeployment(canManage, 60_000);
  // Mounted for the restart waiter's baseline, not for anything this page shows.
  useAdminStatus(canManage);
  const restart = useServerRestart();
  const queryClient = useQueryClient();
  const [uninstallTarget, setUninstallTarget] = useState<InstancePluginRow | null>(null);

  const plugins = data?.plugins ?? [];
  const installed = plugins.filter((p) => p.installed);
  const catalog = plugins.filter((p) => !p.installed && p.builtIn);
  /** True while any installed plugin's running copy predates its bytes on disk */
  const restartRequired = installed.some((p) => p.restartRequired);

  // `restartRequired` describes the process that is RUNNING, so a new boot is
  // the moment that claim goes stale. Invalidating marks it; the refetch is
  // what actually retires the offer, rather than leaving it until the next
  // visit says otherwise. No "Back." banner joins this: the rows coming back
  // without the flag is the confirmation, and a second sentence would be news
  // the page has already delivered.
  useEffect(() => {
    if (restart.outcome !== "back") return;
    // Both keys are watched by mounted queries here, so invalidating them IS
    // the refetch: the offer retires when the rows come back without the flag.
    void queryClient.invalidateQueries({ queryKey: INSTANCE_PLUGINS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PLUGIN_UPDATES_QUERY_KEY });
  }, [restart.outcome, queryClient]);

  // A failed check, a registry read that failed and a failed updates QUERY are
  // different failures, and all mean "no answer" rather than "current": they
  // render as one list of lines so nothing on the card claims an offer it did
  // not get. The query's own failure is included because a 500 or an offline
  // server otherwise looks exactly like every plugin being current.
  const checkErrors = [
    ...(check.error ? [check.error] : []),
    ...(updates.error ? [errMessage(updates.error, "Could not check for plugin updates.")] : []),
    ...(updates.data?.errors ?? []).map((e) => `Could not check ${e.name}: ${e.message}`),
  ];

  return (
    <DashboardPage>
      <PageHeader
        title="Plugins"
        subtitle="Plugin changes apply to every node connected to this server. To launch an agent, install its CLI on the machine where it will run."
      />
      {error && (
        <ErrorBanner
          message="Could not load the instance plugins."
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
      {isLoading && !data && !error && <p className="text-muted-foreground text-sm">Loading…</p>}
      {data && (
        <>
          {/* Above the card: the offer is about the rows below it, and the
              act is the admin's, so a reader never sees a button they cannot
              press. */}
          {canManage && (
            <PluginRestartOffer restartRequired={restartRequired} deployment={deployment.data} restart={restart} />
          )}
          <InstalledPluginsCard
            plugins={installed}
            canManage={canManage}
            onUninstall={setUninstallTarget}
            updates={updates.data?.updates ?? []}
            onCheck={check.check}
            checking={check.pending}
            checkErrors={checkErrors}
          />
          {canManage && <PluginCatalogCard plugins={catalog} />}
          {canManage && <InstallByNameForm plugins={plugins} />}
        </>
      )}
      {/* Mounted only while a row is targeted: the mount is the open, and a
          fresh mount is what makes "keep" the default every time rather than
          a value to remember to reset. */}
      {uninstallTarget && <UninstallPluginDialog plugin={uninstallTarget} onClose={() => setUninstallTarget(null)} />}
    </DashboardPage>
  );
}
