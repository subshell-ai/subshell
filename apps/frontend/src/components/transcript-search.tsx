import type { SearchAddon } from "@xterm/addon-search";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TERMINAL_THEME } from "@/components/subshell-terminal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Find overlay entry point rendered near the terminal header: a button that
 * toggles the find bar. The bar itself is a separate component so the input
 * (and its state) only exists while the overlay is open.
 */
export function TranscriptSearch({
  search,
  onClose,
}: {
  /** The terminal's search addon (null until the terminal has mounted) */
  search: SearchAddon | null;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Find in terminal">
        <ChevronUp className="h-3 w-3" /> Find
      </Button>
    );
  }
  return (
    <TranscriptSearchBar
      search={search}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  );
}

/**
 * Search options for every call. `decorations` is not optional in practice:
 * SearchAddon only emits `onDidChangeResults` when decorations are enabled,
 * so the match counter goes silent without it. `matchOverviewRuler` and
 * `activeMatchColorOverviewRuler` are required fields of the decoration type.
 * Every colour derives from the sanctioned `TERMINAL_THEME` (selection,
 * cursor and foreground tints) so a re-tinted terminal re-colours the finder
 * instead of letting it drift.
 */
const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: TERMINAL_THEME.selectionBackground,
    matchOverviewRuler: TERMINAL_THEME.cursor,
    activeMatchBackground: TERMINAL_THEME.activeMatch,
    activeMatchColorOverviewRuler: TERMINAL_THEME.foreground,
  },
} as const;

/**
 * Find-in-terminal, backed by SearchAddon: matches are highlighted in the
 * terminal itself and the counter comes from the addon's own result event.
 */
function TranscriptSearchBar({
  search,
  onClose,
}: {
  /** The terminal's search addon (null until the terminal has mounted) */
  search: SearchAddon | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 });

  useEffect(() => {
    if (!search) return;
    const disposable = search.onDidChangeResults(setResults);
    return () => disposable.dispose();
  }, [search]);

  // Clear highlights when the bar unmounts so they don't outlive the search.
  useEffect(() => () => search?.clearDecorations(), [search]);

  const find = useCallback(
    (term: string, direction: "next" | "prev") => {
      if (!search) return;
      if (!term) {
        search.clearDecorations();
        setResults({ resultIndex: -1, resultCount: 0 });
        return;
      }
      if (direction === "next") search.findNext(term, SEARCH_OPTIONS);
      else search.findPrevious(term, SEARCH_OPTIONS);
    },
    [search],
  );

  const total = results.resultCount;
  // resultIndex is -1 when the addon's highlight threshold is exceeded; show
  // the count alone rather than a misleading "0/N".
  const label =
    total === 0 ? "no matches" : results.resultIndex < 0 ? `${total} matches` : `${results.resultIndex + 1}/${total}`;

  return (
    <fieldset
      aria-label="Find in terminal"
      className="flex items-center gap-1.5 rounded-md border border-input bg-background p-1"
    >
      <Input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          find(e.target.value.trim(), "next");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(q.trim(), e.shiftKey ? "prev" : "next");
          if (e.key === "Escape") onClose();
        }}
        placeholder="Find…"
        className="h-7 w-52 text-xs"
      />
      {q.trim() && (
        <span className="min-w-16 text-center text-muted-foreground text-xs" aria-live="polite">
          {label}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => find(q.trim(), "prev")}
        disabled={!total}
        aria-label="Previous match"
        title="Previous match"
      >
        <ChevronUp className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => find(q.trim(), "next")}
        disabled={!total}
        aria-label="Next match"
        title="Next match"
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close search">
        <X className="h-3 w-3" />
      </Button>
    </fieldset>
  );
}
