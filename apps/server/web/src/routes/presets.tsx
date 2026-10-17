import { Button } from "@internal/node-admin";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, SlidersHorizontal, Terminal, Upload } from "lucide-react";
import { useState } from "react";
import { DashboardPage } from "@/components/dashboard-page";
import { PageHeader } from "@/components/page-header";
import { AgentPresetLibrary } from "@/components/presets/agent-preset-library";
import { ImportPresetDialog } from "@/components/presets/import-preset-dialog";
import { SshPresetLibrary } from "@/components/presets/ssh-preset-library";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ui/segmented";

export const Route = createFileRoute("/presets")({
  component: PresetsPage,
  validateSearch: (search: Record<string, unknown>): { type?: "ssh" } => (search.type === "ssh" ? { type: "ssh" } : {}),
});

/** URL state, the header menu, and the tab; each tab's library owns its
 *  rows, dialogs, and delete flow (the route stays composition only). */
function PresetsPage() {
  const navigate = useNavigate();
  const { type } = Route.useSearch();
  const active = type ?? "agent";

  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);

  function createPreset(kind: "agent" | "ssh") {
    setShowCreate(true);
    void navigate({ to: "/presets", search: kind === "ssh" ? { type: "ssh" } : {} });
  }

  return (
    <DashboardPage>
      {showImport && (
        <ImportPresetDialog
          onClose={() => setShowImport(false)}
          onImported={(kind) => {
            setShowImport(false);
            void navigate({ to: "/presets", search: kind === "ssh" ? { type: "ssh" } : {} });
          }}
        />
      )}
      <PageHeader
        title="Presets"
        subtitle="Saved launch settings for agents and SSH connections"
        action={
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button />}>
              <Plus /> New preset
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => createPreset("agent")}>
                <SlidersHorizontal /> New agent preset
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => createPreset("ssh")}>
                <Terminal /> New SSH preset
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setShowCreate(false);
                  setShowImport(true);
                }}
              >
                <Upload /> Import preset
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <Segmented
        ariaLabel="Preset type"
        fill={false}
        options={[
          { value: "agent", label: "Agent" },
          { value: "ssh", label: "SSH" },
        ]}
        value={active}
        onChange={(next) => {
          setShowCreate(false);
          void navigate({ to: "/presets", search: next === "ssh" ? { type: "ssh" } : {} });
        }}
      />
      {active === "ssh" ? (
        <SshPresetLibrary
          creating={showCreate}
          onCreate={() => createPreset("ssh")}
          onCreatedClose={() => setShowCreate(false)}
        />
      ) : (
        <AgentPresetLibrary
          creating={showCreate}
          onCreate={() => createPreset("agent")}
          onCreatedClose={() => setShowCreate(false)}
        />
      )}
    </DashboardPage>
  );
}
