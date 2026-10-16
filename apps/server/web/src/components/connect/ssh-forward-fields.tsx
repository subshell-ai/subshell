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
 * explains (spec §7). "The connecting machine" and "the destination" name the
 * two ends: on a remote-node launch "this machine" would read as the browser.
 */
const KIND_HELP: Record<SshForwardDraftRow["kind"], string> = {
  local: "The port opens on the connecting machine, and programs there reach the target through the destination.",
  remote:
    "The destination opens the port and reaches the target through the connecting machine; its own SSH server decides how it binds.",
  dynamic:
    "A SOCKS proxy port opens on the connecting machine; tools that use it pick their own targets and reach them through the destination.",
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
        const needsTarget = row.kind !== "dynamic";
        const idPrefix = `ssh-fwd-${String(index)}`;
        const helpId = `${idPrefix}-kind-help`;
        return (
          <div key={idPrefix} className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <Field className="min-w-0 gap-1">
                <span id={`${idPrefix}-kind-label`} className="font-strong text-label">
                  Kind
                </span>
                <RadioGroup
                  aria-labelledby={`${idPrefix}-kind-label`}
                  value={row.kind}
                  className="flex flex-row flex-wrap items-center gap-x-4 gap-y-1"
                  onValueChange={(value) => patchRow(index, { kind: (value ?? "local") as SshForwardDraftRow["kind"] })}
                >
                  {KIND_LABELS.map((option) => (
                    <Field key={option.value} className="mb-0 flex-row items-center gap-1.5">
                      <RadioGroupItem
                        id={`${idPrefix}-kind-${option.value}`}
                        value={option.value}
                        aria-describedby={row.kind === option.value ? helpId : undefined}
                      />
                      <FieldLabel htmlFor={`${idPrefix}-kind-${option.value}`} className="cursor-pointer">
                        {option.label}
                      </FieldLabel>
                    </Field>
                  ))}
                </RadioGroup>
              </Field>
              <Field className="w-28 min-w-0">
                <Label htmlFor={`${idPrefix}-port`}>
                  {row.kind === "remote" ? "Remote port" : "Local port"}
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
              {needsTarget && (
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
            {/* One sentence per chosen kind, kept below the row it explains; the checked radio points here. */}
            <p id={helpId} className="text-detail text-muted-foreground">
              {KIND_HELP[row.kind]}
            </p>
            {problem && (
              <p role="alert" className={cn(problem.gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail")}>
                {problem.text}
              </p>
            )}
          </div>
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
