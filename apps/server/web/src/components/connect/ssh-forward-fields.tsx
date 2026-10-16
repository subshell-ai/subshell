import { Button, cn, Input, Label } from "@internal/node-admin";
import { SSH_MAX_FORWARD_ROWS } from "@internal/subshell-protocol";
import { Plus, X } from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RequiredMark } from "@/components/ui/required-mark";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { EMPTY_SSH_FORWARD_ROW, type SshForwardDraftRow, sshForwardRowProblem } from "@/lib/ssh-forwards";

/**
 * The port-forwards group (spec 2026-10-15 §7): every row a person declared
 * for this connection, with its kind, ports, and (only on a machine whose
 * owner allowed wide binds) its bind address. Rows are form state until
 * Start; the launch carries them and the rendered config makes them real,
 * and they die with the pane.
 */

const KIND_LABELS = [
  { value: "local", label: "Local (-L)" },
  { value: "remote", label: "Remote (-R)" },
  { value: "dynamic", label: "Dynamic SOCKS (-D)" },
] as const;

/**
 * What the chosen kind does and where its port lives, kept beside the row it
 * explains (spec §7). The ends are named ("the machine you connect from",
 * "the destination") because on a remote-node launch a bare "this machine"
 * would read as the browser. The diagram line traces one request's route with
 * the example values from the placeholders, so the prose names the ends and
 * the arrows show the direction.
 */
const KIND_HELP: Record<SshForwardDraftRow["kind"], string> = {
  local:
    "Opens a port on the machine you connect from. Anything you send to that port reaches the target through the destination.",
  remote:
    "Opens a port on the destination. Anything sent to that port reaches the target on the machine you connect from. The destination's own SSH settings decide whether the port may bind.",
  dynamic:
    "Opens a SOCKS proxy port on the machine you connect from. Tools pointed at it choose their own targets, each reached through the destination.",
};

const KIND_DIAGRAM: Record<SshForwardDraftRow["kind"], string> = {
  local: "program → 5432 on the connecting machine → destination → db.internal:5432",
  remote: "program on the destination → 9090 there → connecting machine → app.local:3000",
  dynamic: "SOCKS client → 1080 on the connecting machine → destination → any host it asks for",
};

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
  const patchRow = (index: number, value: Partial<SshForwardDraftRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...value } : row)));
  return (
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={busy}>
      <legend className="mb-2 font-strong text-label">Port forwards</legend>
      <p className="text-detail text-muted-foreground">
        Each forward opens a listening port for as long as this connection lives, and the port closes when the subshell
        ends.
      </p>
      {rows.map((row, index) => {
        const problem = sshForwardRowProblem(row);
        const idPrefix = `ssh-fwd-${String(index)}`;
        const helpId = `${idPrefix}-kind-help`;
        return (
          <RadioGroup
            key={idPrefix}
            aria-label="Forward kind"
            value={row.kind}
            onValueChange={(value) => patchRow(index, { kind: (value ?? "local") as SshForwardDraftRow["kind"] })}
          >
            {/* The Authentication field's shape: the chosen option carries its
                caption and its controls in the column beside the radio, and the
                other options stay one line each. */}
            {KIND_LABELS.map((option) => {
              const selected = row.kind === option.value;
              return (
                <Field key={option.value} className="mb-0 flex-row items-start gap-3">
                  <RadioGroupItem
                    id={`${idPrefix}-kind-${option.value}`}
                    value={option.value}
                    aria-describedby={selected ? helpId : undefined}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <FieldLabel htmlFor={`${idPrefix}-kind-${option.value}`} className="cursor-pointer">
                      <span>{option.label}</span>
                    </FieldLabel>
                    {selected && (
                      <>
                        <span id={helpId} className="font-regular text-detail text-muted-foreground">
                          {KIND_HELP[option.value]}
                        </span>
                        <span className="font-mono text-detail text-muted-foreground">
                          {KIND_DIAGRAM[option.value]}
                        </span>
                        <div className="mt-2 flex min-w-0 flex-wrap items-end gap-2">
                          <Field className="w-28 min-w-0">
                            <Label htmlFor={`${idPrefix}-port`}>
                              {option.value === "remote" ? "Remote port" : "Local port"}
                              <RequiredMark />
                            </Label>
                            <Input
                              id={`${idPrefix}-port`}
                              inputMode="numeric"
                              placeholder="5432"
                              value={row.listenPort}
                              onChange={(event) => patchRow(index, { listenPort: event.target.value })}
                            />
                          </Field>
                          {option.value !== "dynamic" && (
                            <>
                              <Field className="min-w-40 flex-1">
                                <Label htmlFor={`${idPrefix}-target-host`}>
                                  Target host
                                  <RequiredMark />
                                </Label>
                                <Input
                                  id={`${idPrefix}-target-host`}
                                  placeholder="db.internal"
                                  value={row.targetHost}
                                  onChange={(event) => patchRow(index, { targetHost: event.target.value })}
                                />
                              </Field>
                              <Field className="w-28 min-w-0">
                                <Label htmlFor={`${idPrefix}-target-port`}>
                                  Target port
                                  <RequiredMark />
                                </Label>
                                <Input
                                  id={`${idPrefix}-target-port`}
                                  inputMode="numeric"
                                  placeholder="5432"
                                  value={row.targetPort}
                                  onChange={(event) => patchRow(index, { targetPort: event.target.value })}
                                />
                              </Field>
                            </>
                          )}
                          {(allowWideBind || row.bindHost !== "") && (
                            <Field className="min-w-36 flex-1">
                              <Label htmlFor={`${idPrefix}-bind`}>Bind address</Label>
                              <Input
                                id={`${idPrefix}-bind`}
                                placeholder="loopback"
                                value={row.bindHost}
                                onChange={(event) => patchRow(index, { bindHost: event.target.value })}
                              />
                            </Field>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label="Remove this forward"
                            disabled={busy}
                            onClick={() => onChange(rows.filter((_, i) => i !== index))}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </div>
                        {problem && (
                          <p
                            role="alert"
                            className={cn(problem.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail")}
                          >
                            {problem.text}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </Field>
              );
            })}
          </RadioGroup>
        );
      })}
      {!allowWideBind && (
        <p className="text-detail text-muted-foreground">
          Forwards bind this machine's own loopback address. Its owner can allow other bind addresses in the node's SSH
          settings.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={busy || rows.length >= SSH_MAX_FORWARD_ROWS}
        disabledReason={
          rows.length >= SSH_MAX_FORWARD_ROWS
            ? `A connection carries at most ${String(SSH_MAX_FORWARD_ROWS)} port forwards.`
            : undefined
        }
        onClick={() => onChange([...rows, { ...EMPTY_SSH_FORWARD_ROW }])}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />
        Add port forward
      </Button>
    </fieldset>
  );
}
