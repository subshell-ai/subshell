import { errMessage } from "@internal/node-admin";
import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { type PresetFormValue, parseCommandPaste, presetFormToCommand } from "@/lib/preset-form";

/** Placeholder: a worked command, so the shape is shown rather than described. */
const EXAMPLE = [
  "ANTHROPIC_MODEL=sonnet \\",
  'ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4-5" \\',
  "claude --dangerously-skip-permissions --effort xhigh",
].join("\n");

/** Everything after the last `/` — `/usr/local/bin/claude` is still `claude`. */
function basename(command: string): string {
  const cut = command.lastIndexOf("/");
  return cut === -1 ? command : command.slice(cut + 1);
}

/**
 * The "Paste command" panel: paste the whole line you'd type in a terminal and
 * it becomes this preset's env vars and flags. It edits the SAME
 * `envRows`/`flagRows` the row editors do — nothing new is stored, and
 * switching to "Custom command" shows exactly what was parsed, editable.
 *
 * Two things make it a view of the form rather than a box beside it:
 *
 * - **Mounting IS entering the tab** (the parent renders one panel at a time),
 *   so the textarea seeds itself from {@link presetFormToCommand} in a state
 *   initializer. Rows edited in the other panel are therefore already here,
 *   and no stale paste can overwrite them on the next keystroke.
 * - **Rows are written from the change handler, never from an effect.** The
 *   preview below is derived from the same text in a `useMemo`, so what is
 *   shown and what was stored cannot drift, and a parse failure leaves the
 *   rows alone while the message renders.
 *
 * The command token is reported and IGNORED: a preset runs the agent it
 * names, resolved on the pane's own machine, so a pasted `/usr/local/bin/claude`
 * is stated rather than believed — and a command that is not the selected
 * agent's is called out, because that paste is usually the wrong agent rather
 * than the wrong path.
 */
export function CommandPasteField({
  value,
  onChange,
  agentName,
  agentBinary,
  id,
}: {
  /** Live form state, owned by the parent */
  value: PresetFormValue;
  /** Called with the full replacement state whenever the pasted text parses */
  onChange: (value: PresetFormValue) => void;
  /** Display name of the selected agent, for the ignored-command line */
  agentName: string;
  /** The selected agent's command name, when the catalog knows one */
  agentBinary?: string;
  /** DOM id for the section's label association */
  id?: string;
}) {
  // The seed runs once per mount, and the parent mounts this on tab entry.
  const [text, setText] = useState(() => presetFormToCommand(value, agentBinary ?? ""));

  const parsed = useMemo(() => {
    if (!text.trim()) return {};
    try {
      return { command: parseCommandPaste(text) };
    } catch (err) {
      return { error: errMessage(err, "Could not read that command") };
    }
  }, [text]);

  function edit(next: string) {
    setText(next);
    let result: ReturnType<typeof parseCommandPaste>;
    try {
      result = parseCommandPaste(next);
    } catch {
      // The message is rendered from `parsed`; the rows keep their last good
      // contents rather than emptying while a quote is half-typed.
      return;
    }
    onChange({
      ...value,
      // Both sections keep one blank row so the other panel always has
      // something to type into — the same invariant PairRowsEditor holds.
      envRows: result.env.length > 0 ? result.env : [{ key: "", value: "" }],
      flagRows: result.flags.length > 0 ? result.flags : [{ flag: "", value: "" }],
    });
  }

  const command = parsed.command;
  const envCount = command?.env.length ?? 0;
  const flagCount = command?.flags.length ?? 0;
  const pastedBinary = command?.command !== undefined ? basename(command.command) : null;
  // A mismatch is only claimable when the catalog told us the agent's own
  // command name; without one, the line states the command and stops.
  const mismatch = pastedBinary !== null && agentBinary !== undefined && pastedBinary !== agentBinary;

  return (
    <div className="space-y-2" id={id}>
      <Textarea
        rows={6}
        value={text}
        onChange={(e) => edit(e.target.value)}
        placeholder={EXAMPLE}
        aria-label="Paste a command"
        className="font-mono text-detail"
      />
      {parsed.error !== undefined && <p className="text-destructive text-detail">{parsed.error}</p>}
      {command !== undefined && parsed.error === undefined && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-detail text-muted-foreground">
            {envCount === 0 && flagCount === 0
              ? "Nothing to set: this preset would launch the agent as it is."
              : `${envCount} env var${envCount === 1 ? "" : "s"} · ${flagCount} flag${flagCount === 1 ? "" : "s"}`}
          </p>
          {command.env.length > 0 && (
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
              {command.env.map((row) => (
                <div key={row.key} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="truncate font-mono font-strong text-label">{row.key}</dt>
                  <dd className="truncate font-mono text-detail text-muted-foreground">{row.value || "(empty)"}</dd>
                </div>
              ))}
            </dl>
          )}
          {command.flags.length > 0 && (
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
              {command.flags.map((row, i) => (
                // Flags are positional and may legitimately repeat
                // (`--allow a --allow b`), so the index is the only key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <div key={i} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="truncate font-mono font-strong text-label">{row.flag}</dt>
                  <dd className="truncate font-mono text-detail text-muted-foreground">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {pastedBinary !== null && (
            <p className={mismatch ? "text-detail text-warning" : "text-detail text-muted-foreground"}>
              {mismatch
                ? `“${pastedBinary}” isn't ${agentName}'s command; the agent selected above is what runs.`
                : `“${pastedBinary}” is ignored: subshells run ${agentName} as resolved on the machine they start on.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
