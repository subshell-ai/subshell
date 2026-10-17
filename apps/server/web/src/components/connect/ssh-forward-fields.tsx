import { Button, cn, Input, Label } from "@internal/node-admin";
import { SSH_MAX_FORWARD_ROWS } from "@internal/subshell-protocol";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ChoiceFields } from "@/components/ui/choice-fields";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RequiredMark } from "@/components/ui/required-mark";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import {
  EMPTY_SSH_FORWARD_ROW,
  FORWARD_EXAMPLE,
  type SshForwardDraftRow,
  sshForwardListenText,
  sshForwardRowConflict,
  sshForwardRowDiagram,
  sshForwardRowProblem,
  sshForwardTargetText,
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

/**
 * The duplicate-listen refusal in one sentence, shared by the Add button's
 * tooltip and the alert under the editor so the two voices can't drift.
 */
const CONFLICT_SENTENCE = "Another listed forward already binds that port there.";

/** A line's Listen part: what ssh will really bind, spelled plainly. */
function listenText(row: SshForwardDraftRow): string {
  return sshForwardListenText(row.kind, row.listenPort.trim(), row.bindHost.trim());
}

/** A line's Target part; a SOCKS forward has no fixed target to name. */
function targetText(row: SshForwardDraftRow): string {
  return sshForwardTargetText(row.kind, row.targetHost.trim(), row.targetPort.trim());
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
  const addReason = problem !== null ? problem.text : conflict ? CONFLICT_SENTENCE : undefined;
  const foldEditor = () => {
    // Folding is always a clean slate: the values clear and only the chosen
    // kind stays. Commit and Cancel share this, so whatever closes the editor
    // - a row landing or a mind changing - means the next opening shows
    // nothing stale, and "Cancel" means what it says.
    setEditor({ ...EMPTY_SSH_FORWARD_ROW, kind: editor.kind });
    setComposing(false);
  };
  const addForward = () => {
    if (problem !== null || conflict || atCap) return;
    onChange([...rows, { ...editor }]);
    foldEditor();
  };
  const example = FORWARD_EXAMPLE[editor.kind];
  return (
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={busy}>
      <legend className="mb-2 font-strong text-label">Port forwards</legend>
      <p className="text-detail text-muted-foreground">
        Each forward opens a listening port for as long as this connection lives, and the port closes when the subshell
        ends.
      </p>
      {!allowWideBind && (
        <p className="text-detail text-warning">
          Until the owner turns on <span className="font-strong">“Allow wide port forwards”</span> in this node's SSH
          settings, a forward can only bind 127.0.0.1 on the machine you connect from, so just programs there can reach
          the port. A remote forward binds on the destination instead, under the destination's own policy.
        </p>
      )}
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
            {KINDS.map((option) => (
              <Field key={option.value} className="flex-row items-start gap-3">
                <RadioGroupItem
                  id={`ssh-fwd-kind-${option.value}`}
                  value={option.value}
                  aria-labelledby={`ssh-fwd-title-${option.value}`}
                  aria-describedby={`ssh-fwd-help-${option.value}`}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <FieldLabel
                    htmlFor={`ssh-fwd-kind-${option.value}`}
                    className="flex min-w-0 cursor-pointer flex-col gap-1"
                  >
                    <span id={`ssh-fwd-title-${option.value}`}>{option.label}</span>
                    <span
                      id={`ssh-fwd-help-${option.value}`}
                      className="font-regular text-detail text-muted-foreground"
                    >
                      {KIND_HELP[option.value]}
                    </span>
                  </FieldLabel>
                  {editor.kind === option.value && (
                    <ChoiceFields labelledBy={`ssh-fwd-title-${option.value}`}>
                      <p className="break-words font-mono text-body">{sshForwardRowDiagram(editor)}</p>
                      <div className="mt-2 flex min-w-0 flex-wrap items-end gap-2">
                        <Field className="w-28 min-w-0">
                          <Label htmlFor="ssh-fwd-port">
                            {editor.kind === "remote" ? "Remote port" : "Local port"}
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
                        {editor.kind !== "dynamic" && (
                          <>
                            <Field className="min-w-0 flex-1 basis-40">
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
                          <Field className="min-w-0 flex-1 basis-36">
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
                    </ChoiceFields>
                  )}
                </div>
              </Field>
            ))}
          </RadioGroup>
          {/* Sentences show once a field is touched, not while it sits pristine. */}
          {touched && problem && (
            <p role="alert" className={cn(problem.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail")}>
              {problem.text}
            </p>
          )}
          {/* `conflict` is only computed when there's no other problem, so one
              guard here cannot double-say the row's own sentence. */}
          {touched && conflict && (
            <p role="alert" className="text-destructive text-detail">
              {CONFLICT_SENTENCE} Change the port or the bind, or remove that one.
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
            <Button type="button" variant="ghost" onClick={foldEditor}>
              Cancel
            </Button>
          </div>
        </div>
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
              <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
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
