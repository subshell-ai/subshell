import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { InstallByNameForm } from "@/components/plugins/install-by-name-form";
import { InstalledPluginsCard } from "@/components/plugins/installed-plugins-card";
import { PluginCatalogCard } from "@/components/plugins/plugin-catalog-card";
import { UninstallPluginDialog } from "@/components/plugins/uninstall-plugin-dialog";
import { Button } from "@/components/ui/button";
import { type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { usePublicSettings } from "@/hooks/use-public-settings";

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
 */
function InstancePluginsPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const canManage = viewerIsAdmin === true;
  const { data, error, isLoading, refetch } = useInstancePlugins();
  const [uninstallTarget, setUninstallTarget] = useState<InstancePluginRow | null>(null);

  const plugins = data?.plugins ?? [];
  const installed = plugins.filter((p) => p.installed);
  const catalog = plugins.filter((p) => !p.installed && p.builtIn);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title="Plugins"
        subtitle="What this control plane offers every node. Installs, disables and uninstalls here are instance-wide."
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
          <InstalledPluginsCard plugins={installed} canManage={canManage} onUninstall={setUninstallTarget} />
          {canManage && <PluginCatalogCard plugins={catalog} />}
          {canManage && <InstallByNameForm plugins={plugins} />}
        </>
      )}
      {/* Mounted only while a row is targeted: the mount is the open, and a
          fresh mount is what makes "keep" the default every time rather than
          a value to remember to reset. */}
      {uninstallTarget && <UninstallPluginDialog plugin={uninstallTarget} onClose={() => setUninstallTarget(null)} />}
    </main>
  );
}
