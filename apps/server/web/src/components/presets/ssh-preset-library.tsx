import { apiFetch, Card, CardContent, CardHeader, CardTitle, confirmAction, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Pencil, Play, Terminal, Trash2 } from "lucide-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/actions-menu";
import { EmptyState } from "@/components/empty-state";
import { SshPresetEditor } from "@/components/presets/ssh-preset-editor";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { useNodes } from "@/hooks/use-nodes";
import { useInvalidatePresets } from "@/hooks/use-presets";
import { useSshPresets } from "@/hooks/use-ssh-presets";
import { SSH_PRESET_NAME_MAX } from "@/lib/ssh-input-validation";
import { SSH_AUTHENTICATION_LABELS } from "@/lib/ssh-preset";
import type { SshPreset } from "@/types/preset";

/** SSH presets share library actions with agent presets, but show connection facts. */
export function SshPresetLibrary({
  creating,
  onCreate,
  onCreatedClose,
}: {
  creating: boolean;
  onCreate: () => void;
  onCreatedClose: () => void;
}) {
  const query = useSshPresets();
  const nodes = useNodes();
  const invalidate = useInvalidatePresets();
  const navigate = useNavigate();
  const [editor, setEditor] = useState<{ preset: SshPreset; cloneName?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  function clone(preset: SshPreset) {
    // Case folding mirrors the server's ASCII NOCASE index, same as
    // suggestCloneName's set on the Agent tab.
    const names = new Set(query.data?.map((p) => p.name.toLowerCase()));
    const withSuffix = (suffix: string) => preset.name.slice(0, SSH_PRESET_NAME_MAX - suffix.length) + suffix;
    let name = withSuffix(" (copy)");
    for (let index = 2; names.has(name.toLowerCase()); index++) name = withSuffix(` (copy ${index})`);
    setEditor({ preset, cloneName: name });
  }
  async function remove(preset: SshPreset) {
    if (
      !(await confirmAction({
        title: "Delete this preset?",
        description: `Delete “${preset.name}”? Existing subshells will keep running.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    try {
      setError(null);
      await apiFetch(`/api/presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
      await invalidate();
    } catch (err) {
      setError(errMessage(err, "Couldn’t delete this preset. Try again."));
    }
  }
  return (
    <>
      {creating && <SshPresetEditor onClose={onCreatedClose} />}
      {editor && <SshPresetEditor {...editor} onClose={() => setEditor(null)} />}
      {error && (
        <p role="alert" className="text-destructive text-detail">
          {error}
        </p>
      )}
      <SshQueryStatus query={query} label="SSH presets" />
      {query.isSuccess && !query.data.length && !creating && (
        <EmptyState
          icon={Terminal}
          title="No SSH presets yet"
          description="An SSH preset saves your destination, connecting node, and authentication choices. You can also save one when starting an SSH subshell."
          actionLabel="Create your first SSH preset"
          onAction={onCreate}
        />
      )}
      {query.isSuccess && query.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>SSH presets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="@container overflow-x-auto">
              <table className="w-full text-sm" aria-label="SSH presets">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="pr-4 pb-2 font-strong">
                      Name
                    </th>
                    <th scope="col" className="@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                      Destination
                    </th>
                    <th scope="col" className="@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                      Connect from
                    </th>
                    <th scope="col" className="@lg:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                      Authentication
                    </th>
                    <th scope="col" className="pb-2 text-right font-strong">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((preset) => (
                    <tr key={preset.id} className="border-b align-middle last:border-0">
                      {/* The name opens the editor, same act as the menu's Edit. Not a
                          disclosure: this row already prints the preset's four facts, so
                          there is nothing the name could expand that Edit doesn't show. */}
                      <td className="h-8 @sm:w-1/3 w-full max-w-0 py-0 pr-4">
                        <button
                          type="button"
                          title={preset.name}
                          className="block max-w-full truncate rounded-md text-left font-strong hover:underline"
                          onClick={() => setEditor({ preset })}
                        >
                          {preset.name}
                        </button>
                      </td>
                      <td className="@sm:table-cell hidden h-8 max-w-0 truncate whitespace-nowrap py-0 pr-4 font-mono text-muted-foreground">
                        {preset.destination}
                      </td>
                      <td className="@sm:table-cell hidden h-8 max-w-0 truncate whitespace-nowrap py-0 pr-4 text-muted-foreground">
                        {nodes.data
                          ? (nodes.data.nodes.find((node) => node.id === preset.nodeId)?.name ?? "Node unavailable")
                          : ""}
                      </td>
                      <td className="@lg:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
                        {SSH_AUTHENTICATION_LABELS[preset.authentication]}
                      </td>
                      <td className="h-8 w-px py-0 text-right">
                        <ActionsMenu
                          label={preset.name}
                          items={[
                            {
                              label: "Connect",
                              icon: Play,
                              onSelect: () => void navigate({ to: "/new", search: { kind: "ssh", preset: preset.id } }),
                            },
                            { label: "Edit", icon: Pencil, onSelect: () => setEditor({ preset }) },
                            { label: "Clone preset", icon: Copy, onSelect: () => clone(preset) },
                            {
                              label: "Delete preset",
                              icon: Trash2,
                              destructive: true,
                              onSelect: () => void remove(preset),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
