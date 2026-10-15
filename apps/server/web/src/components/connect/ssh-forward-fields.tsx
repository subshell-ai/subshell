import { Button, Input, Label } from "@internal/node-admin";
import { SSH_MAX_FORWARD_ROWS } from "@internal/subshell-protocol";
import { Plus, X } from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import { RequiredMark } from "@/components/ui/required-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EMPTY_SSH_FORWARD_ROW, type SshForwardDraftRow, sshForwardRowProblems } from "@/lib/ssh-forwards";

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

function kindLabel(kind: SshForwardDraftRow["kind"]): string {
  return KIND_LABELS.find((option) => option.value === kind)?.label ?? kind;
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
  const patchRow = (index: number, value: Partial<SshForwardDraftRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...value } : row)));
  return (
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={busy}>
      <legend className="mb-2 font-strong text-label">Port forwards</legend>
      <p className="text-detail text-muted-foreground">
        Each forward opens a listening port for as long as this connection lives. A local or dynamic forward binds it on
        the connecting machine, so programs there reach a host the destination can see; a remote one asks the
        destination to bind a port that reaches a host the connecting machine can see.
      </p>
      {rows.map((row, index) => {
        const problem = sshForwardRowProblems(row);
        const needsTarget = row.kind !== "dynamic";
        const idPrefix = `ssh-fwd-${String(index)}`;
        return (
          <div key={idPrefix} className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <Field className="w-40 min-w-0">
                <FieldLabel htmlFor={`${idPrefix}-kind`}>Kind</FieldLabel>
                <Select
                  id={`${idPrefix}-kind`}
                  items={KIND_LABELS.map((option) => ({ value: option.value, label: kindLabel(option.value) }))}
                  value={row.kind}
                  onValueChange={(value) => patchRow(index, { kind: (value ?? "local") as SshForwardDraftRow["kind"] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_LABELS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            {problem && (
              <p role="alert" className="text-destructive text-detail">
                {problem}
              </p>
            )}
          </div>
        );
      })}
      {!allowWideBind && (
        <p className="text-detail text-muted-foreground">
          Forwards bind this machine's own loopback address. Its owner can allow other bind addresses on the node's SSH
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
