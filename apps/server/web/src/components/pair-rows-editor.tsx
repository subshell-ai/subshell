import { Button, errMessage, Input } from "@internal/node-admin";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { AutocompleteInput } from "@/components/autocomplete-input";
import { Textarea } from "@/components/ui/textarea";
import type { Suggestion } from "@/lib/autocomplete";

/** One editor row: a first column (autocompleted) and a free-text second. */
export interface PairRow {
  /** Flag/env-name token ("" = untouched placeholder row) */
  first: string;
  /** Value text ("" = bare flag / empty env value) */
  second: string;
}

/**
 * Key/value row editor shared by the preset form's env and flag sections:
 * one autocomplete-backed row per entry, add/remove buttons, and a
 * "Paste many" area that bulk-parses text into rows. Parsing is delegated to
 * `parsePaste` (which may throw — the message is surfaced inline) and always
 * appends: existing rows never disappear.
 */
export function PairRowsEditor({
  rows,
  onChange,
  suggestions,
  firstLabel,
  firstPlaceholder,
  secondPlaceholder,
  pastePlaceholder,
  parsePaste,
  id,
}: {
  /** Live rows, owned by the caller */
  rows: PairRow[];
  /** Called with the full replacement list on any edit */
  onChange: (rows: PairRow[]) => void;
  /** Candidates for the first column */
  suggestions: Suggestion[];
  /** Accessible name for the first column ("Variable" / "Flag") */
  firstLabel: string;
  /** Placeholder for the first column */
  firstPlaceholder: string;
  /** Placeholder for the value column */
  secondPlaceholder: string;
  /** Placeholder for the bulk-paste textarea */
  pastePlaceholder: string;
  /** Bulk-paste parser; throws with a user-facing message on bad input */
  parsePaste: (text: string) => PairRow[];
  /** DOM id for the section's label association */
  id?: string;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo<{ rows?: PairRow[]; error?: string }>(() => {
    if (!pasteText.trim()) return {};
    try {
      return { rows: parsePaste(pasteText) };
    } catch (err) {
      return { error: errMessage(err, "Could not parse that") };
    }
  }, [pasteText, parsePaste]);

  function updateRow(index: number, patch: Partial<PairRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    const next = rows.filter((_, i) => i !== index);
    // The section always shows at least one blank row to type into.
    onChange(next.length > 0 ? next : [{ first: "", second: "" }]);
  }

  function applyPaste() {
    if (!parsed.rows || parsed.rows.length === 0) return;
    const kept = rows.filter((r) => r.first.trim() !== "" || r.second !== "");
    onChange([...kept, ...parsed.rows]);
    setPasteOpen(false);
    setPasteText("");
    setError(null);
  }

  return (
    // The id rides the ROOT (Label.htmlFor points here, and e2e scopes the
    // section's own controls — rows, "Paste many", paste box — by it).
    <div className="space-y-2" id={id}>
      <div className="space-y-2">
        {rows.map((row, i) => (
          // Rows are positional form state with no id; they are only added at
          // the end and removed by index, which React handles correctly here.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <AutocompleteInput
              value={row.first}
              onChange={(v) => updateRow(i, { first: v })}
              suggestions={suggestions}
              placeholder={firstPlaceholder}
              ariaLabel={`${firstLabel} ${i + 1}`}
            />
            <Input
              value={row.second}
              onChange={(e) => updateRow(i, { second: e.target.value })}
              placeholder={secondPlaceholder}
              aria-label={`Value for ${row.first || firstLabel.toLowerCase()} ${i + 1}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => removeRow(i)}
              aria-label={`Remove ${row.first || firstLabel.toLowerCase()} ${i + 1}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { first: "", second: "" }])}
        >
          <Plus className="size-3.5" /> Add row
        </Button>
        {/* The dense muted link recipe — `Button variant="link"` (focus ring,
            touch height) flattened to the row's text size. e2e 01 drives
            this by role+name ("Paste many"), which the Button preserves. */}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-detail text-muted-foreground underline hover:text-foreground"
          onClick={() => {
            setPasteOpen((v) => !v);
            setError(null);
          }}
        >
          {pasteOpen ? "Hide paste" : "Paste many"}
        </Button>
      </div>
      {pasteOpen && (
        <div className="space-y-2">
          <Textarea
            rows={4}
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setError(null);
            }}
            placeholder={pastePlaceholder}
            aria-label={`Paste ${firstLabel.toLowerCase()}s in bulk`}
            className="font-mono text-detail"
          />
          {(parsed.error || error) && <p className="text-destructive text-detail">{parsed.error ?? error}</p>}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!parsed.rows || parsed.rows.length === 0}
              onClick={() => {
                if (parsed.rows && parsed.rows.length === 0) setError("Nothing to add");
                else applyPaste();
              }}
            >
              {parsed.rows && parsed.rows.length > 0
                ? `Add ${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}`
                : "Add rows"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
