import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  HelperCaption,
  NODE_QUERY_KEY,
  NODES_QUERY_KEY,
  type NodeDetail,
} from "@internal/node-admin";
import { CROSS_AGENT_DIR_MAX, CROSS_AGENT_DIRS_MAX, CROSS_AGENT_NOTES_MAX } from "@internal/subshell-protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DirectoryPickerInput } from "@/components/directory-picker-input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/** Edits the guidance agents see when discovering a node through MCP. */
export function NodeCrossAgentCard({ node }: { node: NodeDetail }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [draft, setDraft] = useState<{ notes: string; directories: string } | null>(null);
  const value = draft ?? {
    notes: node.crossCommNotes ?? "",
    directories: (node.recommendedStartingDirs ?? []).join("\n"),
  };
  const directories = value.directories
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const problem =
    value.notes.length > CROSS_AGENT_NOTES_MAX
      ? `Keep notes under ${CROSS_AGENT_NOTES_MAX} characters.`
      : directories.length > CROSS_AGENT_DIRS_MAX
        ? `Suggest up to ${CROSS_AGENT_DIRS_MAX} directories.`
        : directories.some(
              (path) =>
                !path.startsWith("/") ||
                path.length > CROSS_AGENT_DIR_MAX ||
                path.includes("\0") ||
                path.includes("\r"),
            )
          ? `Use absolute paths of up to ${CROSS_AGENT_DIR_MAX} characters, one per line.`
          : null;
  const path = directoryDraft.trim();
  const directoryProblem = !path
    ? "Enter a directory first."
    : !path.startsWith("/") || path.length > CROSS_AGENT_DIR_MAX || /[\0\r\n]/.test(path)
      ? `Use an absolute path of up to ${CROSS_AGENT_DIR_MAX} characters.`
      : directories.includes(path)
        ? "This directory is already listed."
        : directories.length >= CROSS_AGENT_DIRS_MAX
          ? `Suggest up to ${CROSS_AGENT_DIRS_MAX} directories.`
          : null;
  const restriction =
    node.kind === "local"
      ? "Only a server admin can edit this guidance."
      : "Only the node owner can edit this guidance.";
  const save = useMutation({
    mutationFn: (nextDirectories: string[] = directories) =>
      apiFetch<{ ok: boolean }>(`/api/nodes/${encodeURIComponent(node.id)}/cross-agent`, {
        method: "PUT",
        body: JSON.stringify({ crossCommNotes: value.notes || null, recommendedStartingDirs: nextDirectories }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, node.id] }),
        queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY }),
      ]);
      setDraft(null);
      setAdding(false);
      setDirectoryDraft("");
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cross-agent communication</CardTitle>
        <CardDescription>
          Give calling agents context about this node when they discover it through MCP.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="node-cross-agent-notes">Notes for calling agents</FieldLabel>
            <Textarea
              id="node-cross-agent-notes"
              aria-describedby="node-cross-agent-notes-help"
              rows={5}
              maxLength={CROSS_AGENT_NOTES_MAX}
              readOnly={!node.canManage || save.isPending}
              value={value.notes}
              onChange={(event) => setDraft({ ...value, notes: event.target.value })}
            />
            <HelperCaption id="node-cross-agent-notes-help">
              Agents read these notes through MCP to decide when and how to use this node. For example: “Use this node
              for Linux builds; run tests with Bun.”
            </HelperCaption>
          </Field>
          <Field>
            <FieldLabel>Recommended starting directories</FieldLabel>
            <HelperCaption>
              These are suggested places to start. The node's directory permissions still apply.
            </HelperCaption>
            <ul className="flex flex-col gap-1.5">
              {directories.map((dir) => (
                <li key={dir} className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5">
                  <code className="truncate font-mono text-detail">{dir}</code>
                  {node.canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${dir}`}
                      disabled={save.isPending}
                      disabledReason="Wait for guidance to save."
                      onClick={() => save.mutate(directories.filter((path) => path !== dir))}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {node.canManage &&
              (adding ? (
                <div className="flex flex-col gap-2">
                  <FieldLabel htmlFor="node-cross-agent-directory">Directory</FieldLabel>
                  <DirectoryPickerInput
                    id="node-cross-agent-directory"
                    value={directoryDraft}
                    onChange={setDirectoryDraft}
                    nodeId={node.id}
                    nodeName={node.name}
                    placeholder="/home/you/projects"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={save.isPending || directoryProblem !== null || problem !== null}
                      disabledReason={
                        save.isPending ? "Wait for guidance to save." : (directoryProblem ?? problem ?? undefined)
                      }
                      onClick={() => {
                        if (!save.isPending && !directoryProblem && !problem)
                          save.mutate([...directories, directoryDraft.trim()]);
                      }}
                    >
                      Add directory
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      disabledReason="Wait for guidance to save."
                      onClick={() => {
                        setAdding(false);
                        setDirectoryDraft("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  className="self-start"
                  size="sm"
                  variant="outline"
                  disabled={save.isPending || directories.length >= CROSS_AGENT_DIRS_MAX}
                  disabledReason={
                    save.isPending ? "Wait for guidance to save." : `Suggest up to ${CROSS_AGENT_DIRS_MAX} directories.`
                  }
                  onClick={() => setAdding(true)}
                >
                  <Plus /> Add directory
                </Button>
              ))}
          </Field>
        </FieldGroup>
        {!node.canManage && <p className="text-detail text-warning">{restriction}</p>}
        {problem && <p className="text-destructive text-detail">{problem}</p>}
        {save.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(save.error, "Couldn't save cross-agent guidance.")}
          </p>
        )}
        {save.isSuccess && draft === null && (
          <p role="status" className="text-detail text-success">
            Guidance saved.
          </p>
        )}
        <Button
          className="self-start"
          disabled={!node.canManage || save.isPending || problem !== null || draft === null}
          disabledReason={
            !node.canManage ? restriction : save.isPending ? "Saving guidance." : (problem ?? "No changes to save.")
          }
          onClick={() => {
            if (node.canManage && !save.isPending && !problem && draft !== null) save.mutate(directories);
          }}
        >
          {save.isPending ? "Saving…" : "Save guidance"}
        </Button>
      </CardContent>
    </Card>
  );
}
