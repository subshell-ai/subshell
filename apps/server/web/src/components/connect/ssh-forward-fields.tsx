import { Button, cn, Input, Label } from "@internal/node-admin";
import { SSH_MAX_FORWARD_ROWS } from "@internal/subshell-protocol";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RequiredMark } from "@/components/ui/required-mark";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import {
  EMPTY_SSH_FORWARD_ROW,
  FORWARD_EXAMPLE,
  type SshForwardDraftRow,
  sshForwardRowConflict,
  sshForwardRowDiagram,
  sshForwardRowProblem,
} from "@/lib/ssh-forwards";

/**
 * The port-forwards group (spec 2026-10-15 §7), shaped like the app's other
 * add-a-thing lists: the section starts as one "Add port forward" button and
 * nothing else. Pressing it reveals the editor for ONE forward; commit puts
 * that row in the list below (enabled only when the row is valid and doesn't
 * re-bind a listed port) and folds the editor away again, so a person who
 * declared nothing never sees a form. The editor is state that never leaves
 * the component until it is added; the list holds what `onChange` commits
 * and what the launch carries. Forwards die with the pane, and the intro says
 * so.
 */

const KINDS = [
  { value: "local", label: "Local (-L)", short: "Local" },
  { value: "remote", label: "Remote (-R)", short: "Remote" },
  { value: "dynamic", label: "Dynamic SOCKS (-D)", short: "Dynamic" },
] as const;

/**
 * What the chosen kind does and where its port lives, kept beside the option
 * it explains (spec §7). The ends are named ("the machine you connect from",
 * "the destination") because on a remote-node launch a bare "this machine"
 * would read as the browser. The diagram (sshForwardRowDiagram) traces one
 * request with the editor's own typed values, so the prose names the ends
 * and the arrows show the direction.
 */
const KIND_HELP: Record<SshForwardDraftRow["kind"], string> = {
  local:
    "Opens a port on the machine you connect from. Anything you send to that port reaches the target through the destination.",
  remote:
    "Opens a port on the destination. Anything sent to that port reaches the target on the machine you connect from. The destination's own SSH settings decide whether the port may bind.",
  dynamic:
    "Opens a SOCKS proxy port on the machine you connect from. Tools pointed at it choose their own targets, each reached through the destination.",
};

/** A line's Listen part: what ssh will really bind, spelled plainly. */
function listenText(row: SshForwardDraftRow): string {
  const port = row.listenPort.trim();
  const bind = row.bindHost.trim();
  if (bind !== "") return `${bind}:${port}`;
  return row.kind === "remote" ? `${port} (by policy)` : `loopback:${port}`;
}

/** A line's Target part; a SOCKS forward has no fixed target to name. */
function targetText(row: SshForwardDraftRow): string {
  return row.kind === "dynamic" ? "any host the tool picks" : `${row.targetHost.trim()}:${row.targetPort.trim()}`;
}

export function SshForwardFields({
  rows,
  allowWideBind,
  busy,
  onChange,
}: {
  rows: SshForwardDraftRow[];
  /** The selected machine's wide-bind allowance; false hides the bind field. */
  allowWideBind: boolean;
  busy: boolean;
  onChange: (rows: SshForwardDraftRow[]) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [editor, setEditor] = useState<SshForwardDraftRow>({ ...EMPTY_SSH_FORWARD_ROW });
  const patchEditor = (value: Partial<SshForwardDraftRow>) => setEditor((current) => ({ ...current, ...value }));
  const problem = sshForwardRowProblem(editor);
  const touched = Object.entries(editor).some(([key, value]) => key !== "kind" && value !== "");
  const conflict = problem === null && touched && sshForwardRowConflict(editor, rows);
  const atCap = rows.length >= SSH_MAX_FORWARD_ROWS;
  const capReason = `A connection carries at most ${String(SSH_MAX_FORWARD_ROWS)} port forwards.`;
  const addReason =
    problem !== null ? problem.text : conflict ? "Another listed forward already binds that port there." : undefined;
  const addForward = () => {
    if (problem !== null || conflict || atCap) return;
    onChange([...rows, { ...editor }]);
    // The row is committed; fold the editor away. Keep the chosen kind (the
    // next forward is usually the same shape) and clear the values, so the
    // editor is never a stale copy of what was added.
    setEditor({ ...EMPTY_SSH_FORWARD_ROW, kind: editor.kind });
    setComposing(false);
  };
  const helpId = "ssh-fwd-kind-help";
  const example = FORWARD_EXAMPLE[editor.kind];
  return (
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={busy}>
      <legend className="mb-2 font-strong text-label">Port forwards</legend>
      <p className="text-detail text-muted-foreground">
        Each forward opens a listening port for as long as this connection lives, and the port closes when the subshell
        ends.
      </p>
      {!composing ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={atCap}
          disabledReason={atCap ? capReason : undefined}
          onClick={() => setComposing(true)}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add port forward
        </Button>
      ) : (
        <div className="contents">
          <RadioGroup
            aria-label="Forward kind"
            value={editor.kind}
            onValueChange={(value) => patchEditor({ kind: (value ?? "local") as SshForwardDraftRow["kind"] })}
          >
            {/* The Authentication field's shape: the chosen option carries its
            caption, route diagram and fields in the column beside the radio,
            and the other options stay one line each. */}
            {KINDS.map((option) => {
              const selected = editor.kind === option.value;
              return (
                <Field key={option.value} className="mb-0 flex-row items-start gap-3">
                  <RadioGroupItem
                    id={`ssh-fwd-kind-${option.value}`}
                    value={option.value}
                    aria-describedby={selected ? helpId : undefined}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <FieldLabel htmlFor={`ssh-fwd-kind-${option.value}`} className="cursor-pointer">
                      <span>{option.label}</span>
                    </FieldLabel>
                    {selected && (
                      <>
                        <span id={helpId} className="font-regular text-detail text-muted-foreground">
                          {KIND_HELP[option.value]}
                        </span>
                        <span className="font-mono text-detail text-muted-foreground">
                          {sshForwardRowDiagram(editor)}
                        </span>
                        <div className="mt-2 flex min-w-0 flex-wrap items-end gap-2">
                          <Field className="w-28 min-w-0">
                            <Label htmlFor="ssh-fwd-port">
                              {option.value === "remote" ? "Remote port" : "Local port"}
                              <RequiredMark />
                            </Label>
                            <Input
                              id="ssh-fwd-port"
                              inputMode="numeric"
                              placeholder={example.listen}
                              value={editor.listenPort}
                              onChange={(event) => patchEditor({ listenPort: event.target.value })}
                            />
                          </Field>
                          {option.value !== "dynamic" && (
                            <>
                              <Field className="min-w-40 flex-1">
                                <Label htmlFor="ssh-fwd-target-host">
                                  Target host
                                  <RequiredMark />
                                </Label>
                                <Input
                                  id="ssh-fwd-target-host"
                                  placeholder={example.host}
                                  value={editor.targetHost}
                                  onChange={(event) => patchEditor({ targetHost: event.target.value })}
                                />
                              </Field>
                              <Field className="w-28 min-w-0">
                                <Label htmlFor="ssh-fwd-target-port">
                                  Target port
                                  <RequiredMark />
                                </Label>
                                <Input
                                  id="ssh-fwd-target-port"
                                  inputMode="numeric"
                                  placeholder={example.port}
                                  value={editor.targetPort}
                                  onChange={(event) => patchEditor({ targetPort: event.target.value })}
                                />
                              </Field>
                            </>
                          )}
                          {(allowWideBind || editor.bindHost !== "") && (
                            <Field className="min-w-36 flex-1">
                              <Label htmlFor="ssh-fwd-bind">Bind address</Label>
                              <Input
                                id="ssh-fwd-bind"
                                placeholder="loopback"
                                value={editor.bindHost}
                                onChange={(event) => patchEditor({ bindHost: event.target.value })}
                              />
                            </Field>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </Field>
              );
            })}
          </RadioGroup>
          {/* Sentences show once a field is touched, not while it sits pristine. */}
          {touched && problem && (
            <p role="alert" className={cn(problem.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail")}>
              {problem.text}
            </p>
          )}
          {touched && conflict && problem === null && (
            <p role="alert" className="text-destructive text-detail">
              Another listed forward already binds that port there. Change the port or the bind, or remove that one.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={addForward}
              disabled={busy || addReason !== undefined}
              disabledReason={addReason}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add port forward
            </Button>
            <Button type="button" variant="ghost" onClick={() => setComposing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!allowWideBind && (composing || rows.length > 0) && (
        <p className="text-detail text-muted-foreground">
          Forwards bind this machine's own loopback address. Its owner can allow other bind addresses in the node's SSH
          settings.
        </p>
      )}
      {rows.length > 0 && (
        // The declared forwards as the dialog's other lists read (the sharing
        // dialog's grants are the worked example): one line each, the control
        // right, no card and no header row. What ssh will really listen on
        // stays monospace; a SOCKS forward names no target, so its ends are
        // prose.
        <div className="flex flex-col gap-2">
          {rows.map((row, index) => (
            // A row's listen identity is unique in this list: the Add button
            // and the server both refuse a port the list already binds, so
            // kind + bind spelling + port cannot repeat.
            <div
              key={`${row.kind}|${row.bindHost.trim()}|${row.listenPort.trim()}`}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="text-muted-foreground">
                  {KINDS.find((option) => option.value === row.kind)?.short ?? row.kind}
                </span>
                <span aria-hidden="true"> · </span>
                <span className="font-mono">{listenText(row)}</span>
                <span aria-hidden="true"> {"→"} </span>
                <span className={row.kind === "dynamic" ? "text-muted-foreground" : "font-mono"}>
                  {targetText(row)}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove this forward"
                disabled={busy}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
