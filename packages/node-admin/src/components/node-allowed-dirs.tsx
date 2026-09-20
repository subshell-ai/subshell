import { Plus, Trash2 } from "lucide-react";
import { type JSX, useState } from "react";
import { useSetNodeAllowedDirs } from "../hooks/use-node-detail";
import type { Node } from "../types/node";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

/**
 * The node's directory allowlist — which directories subshells may be created
 * under on this machine (spec 2026-09-05).
 *
 * Owner-only to edit (`canManage`, the server's gate too — the controls simply
 * do not render for anyone else), but READ-visible to everyone who can see the
 * node: a "directory not allowed" refusal is unexplainable without the rules
 * that caused it.
 *
 * The copy carries two things the mechanism cannot: that an empty list means
 * unrestricted rather than locked down, and that the rules gate NEW subshells
 * and restarts, not the panes already running.
 */
/**
 * The picker is injected, not imported: the folder browser is a
 * control-plane thing (it walks the server's file API), and a package the
 * node's dashboard shares cannot reach it. The plane passes its
 * `DirectoryPickerInput`; nobody passes one when there is nothing to edit
 * into — the node's OWN dashboard renders this card `readOnly`, because the
 * plane holds its own copy of the list, enforces it at launch, and re-pushes
 * on every `ready`. A local edit would be a lie by the next reconnect.
 */
export function NodeAllowedDirs({
  node,
  readOnly = false,
  renderEditor,
  onDirsSaved,
}: {
  node: Node;
  readOnly?: boolean;
  renderEditor?: (args: { value: string; onChange: (v: string) => void; placeholder: string }) => JSX.Element;
  onDirsSaved?: () => void;
}) {
  const dirs = node.allowedDirs;
  const setDirs = useSetNodeAllowedDirs(node.id);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(next: string[]): Promise<void> {
    setError(null);
    try {
      await setDirs.mutateAsync(next);
      setAdding(false);
      setDraft("");
      onDirsSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the directory rules");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allowed directories</CardTitle>
        <CardDescription>
          {dirs.length === 0
            ? "Any directory. Subshells on this node can be created anywhere its user can read. Add a directory to restrict that."
            : "Subshells on this node can only be created in these directories, or anywhere beneath them."}{" "}
          Applies to new subshells and to restarts; panes already running are unaffected.{" "}
          {readOnly
            ? "These rules are managed by the control plane — it enforces its own copy at launch and re-pushes this machine's copy; edit them in its Nodes UI."
            : "The node enforces this itself, so the rule holds even if it loses contact with this server."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {dirs.length > 0 && (
          <ul className="space-y-1.5">
            {dirs.map((dir) => (
              <li key={dir} className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5">
                <code className="truncate font-mono text-detail">{dir}</code>
                {node.canManage && !readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${dir}`}
                    disabled={setDirs.isPending}
                    onClick={() => void save(dirs.filter((d) => d !== dir))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {node.canManage &&
          !readOnly &&
          (adding ? (
            <div className="space-y-2">
              {/* The picker is deliberately UNSCOPED here: you have to be able
                  to browse to a directory in order to permit it, and scoping
                  it to the current rules would make the first rule
                  unaddable. */}
              {renderEditor?.({ value: draft, onChange: setDraft, placeholder: "/home/you/projects" })}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!draft.trim() || setDirs.isPending}
                  onClick={() => void save([...dirs, draft.trim()])}
                >
                  Add directory
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={setDirs.isPending}
                  onClick={() => {
                    setAdding(false);
                    setDraft("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={setDirs.isPending} onClick={() => setAdding(true)}>
              <Plus className="h-3 w-3" /> Add directory
            </Button>
          ))}

        {dirs.length > 0 && node.canManage && !readOnly && (
          <p className="text-detail text-muted-foreground">
            Removing every directory returns this node to unrestricted.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
