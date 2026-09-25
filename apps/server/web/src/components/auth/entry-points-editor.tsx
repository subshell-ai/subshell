import { Badge, Button, Input, Label } from "@internal/node-admin";
import { X } from "lucide-react";
import { type Dispatch, type SetStateAction, useState } from "react";
import { normalizeOriginEntry } from "@/components/auth/entry-origins";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The Select's escape hatch: a free-typed address the registry has not learned. */
const OTHER = "__other__";

/**
 * The entry-points list editor (spec §5a), split out of `provider-dialog.tsx`
 * by review Minor 5: a list over the live origin registry plus a typed
 * escape. The first row is the canonical the round trip always lands on (the
 * emitted redirect URI is built from list position 0 on 1.7.1 — measured,
 * provider-rows.ts), and it is PINNED there with NO control at all: "not
 * removable" is the operator's rule, and without position 0 there is no
 * canonical to build redirect URIs from, so the control that would empty the
 * field must not exist. Nothing
 * else about the order means anything server-side — position 0 is the only
 * position with a consequence — so there are no move arrows either (operator
 * ask 2026-09-25): the rest are a set, in the order they were added. The
 * badge names position 0 "Public base URL" ONLY when it actually is the
 * instance's base URL (operator ruling on review M-3): an API-created row can
 * store anything first, and a badge that asserts a fact it cannot see would
 * be the table saying a wrong thing confidently. Otherwise it reads
 * "Callback base" — the one thing position 0 always is. The entries
 * themselves live in the form (it saves them); the pick, the typed Other
 * text and the refusal are this editor's own state.
 */
export function EntryPointsEditor({
  entries,
  setEntries,
  candidates,
  publicBaseOrigin,
}: {
  entries: string[];
  setEntries: Dispatch<SetStateAction<string[]>>;
  /** The registry's addresses, best first (`entryOriginCandidates`). */
  candidates: string[];
  /** The instance's public base URL as a canonical origin, or null if unknown. */
  publicBaseOrigin?: string | null;
}) {
  const [candidate, setCandidate] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);

  const offered = [...candidates.filter((c) => !entries.includes(c)), OTHER];
  const selected = offered.find((c) => c === candidate) ?? offered[0];

  function addEntry(): void {
    setEntryError(null);
    const raw = selected === OTHER ? otherText : selected;
    const origin = normalizeOriginEntry(raw ?? "");
    if (!origin) {
      setEntryError("Enter a full http(s) address with no path, like https://plane.example.");
      return;
    }
    if (!entries.includes(origin)) setEntries((prev) => [...prev, origin]);
    setOtherText("");
  }

  return (
    <div className="space-y-2">
      <Label>Entry points</Label>
      <p className="text-detail text-muted-foreground">
        The addresses people will sign in from. Each one needs its callback registered at the provider.
      </p>
      <ul className="space-y-1">
        {entries.map((origin, i) => (
          <li key={origin} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-detail">{origin}</span>
            {i === 0 && (
              <Badge variant="secondary">
                {publicBaseOrigin != null && origin === publicBaseOrigin ? "Public base URL" : "Callback base"}
              </Badge>
            )}
            {i > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${origin}`}
                onClick={() => setEntries((prev) => prev.filter((o) => o !== origin))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="text-detail text-muted-foreground">No entry points yet.</li>}
      </ul>
      <div className="flex items-start gap-2">
        <Select
          value={selected ?? null}
          onValueChange={(v) => {
            if (typeof v === "string") setCandidate(v);
          }}
          // With every candidate already an entry, Other is the only choice
          // left and already showing; the Select has nothing else to offer.
          disabled={offered.length === 1}
          items={offered.map((o) => ({ value: o, label: o === OTHER ? "Other…" : o }))}
        >
          <SelectTrigger aria-label="Address to add" className="min-w-0 flex-1">
            <SelectValue placeholder="Choose an address" />
          </SelectTrigger>
          <SelectContent>
            {offered.map((o) => (
              <SelectItem key={o} value={o}>
                <span className="truncate">{o === OTHER ? "Other…" : o}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* "Other…" exists exactly for the case where every registry
            candidate is already an entry, so when it is what is selected,
            Add keys on the typed text rather than refusing the escape.
            A chosen candidate is pre-vetted by the candidate builder. */}
        <Button
          type="button"
          onClick={addEntry}
          disabled={selected === OTHER && normalizeOriginEntry(otherText) === null}
        >
          Add
        </Button>
      </div>
      {selected === OTHER && (
        <Input
          aria-label="Other address"
          value={otherText}
          onChange={(e) => setOtherText(e.target.value)}
          placeholder="https://still-learning.example"
        />
      )}
      {entryError && (
        <p role="alert" className="text-destructive text-detail">
          {entryError}
        </p>
      )}
    </div>
  );
}
