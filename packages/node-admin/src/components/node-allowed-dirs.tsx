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
 * Owner-only to edit (`canManage`, the server's gate too). The controls simply
 * do not render for anyone else), but READ-visible to everyone who can see the
 * node: a "directory not allowed" refusal is unexplainable without the rules
 * that caused it.
 *
 * The copy carries the two things the mechanism cannot: an empty list means
 * unrestricted rather than locked down, and the rules gate NEW subshells and
 * restarts, not the panes already running. Two sentences per state, per
 * `docs/design-system.md` (copy length).
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
  /** The one expression of "this viewer may change the list", used by the
   *  copy and by the controls: `canManage` is the server's own answer, and
   *  a read-only surface never edits whatever else it grants. */
  const canEdit = node.canManage && !readOnly;
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
            ? canEdit
              ? "Subshells on this machine can start anywhere its user can reach. Add a directory to limit them to it and what is inside."
              : "Subshells on this machine can start anywhere its user can reach."
            : "New subshells and restarts start only inside these directories or what is under them. Panes already running are unaffected."}
          {readOnly && (
            <p className="text-detail text-muted-foreground">These rules are managed by the control plane.</p>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {dirs.length > 0 && (
          <ul className="space-y-1.5">
            {dirs.map((dir) => (
              <li key={dir} className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5">
                <code className="truncate font-mono text-detail">{dir}</code>
                {canEdit && (
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

        {canEdit &&
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

        {dirs.length > 0 && canEdit && (
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
