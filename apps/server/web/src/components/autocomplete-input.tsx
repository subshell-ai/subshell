import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { filterSuggestions, type Suggestion } from "@/lib/autocomplete";
import { cn } from "@/lib/utils";

/**
 * A text input with a filtered suggestion dropdown, used for env-var names
 * and flag tokens in the preset editor. Suggestions are exactly that —
 * anything typed is accepted, the list only helps.
 *
 * Note on ARIA: this repo's biome config strips listbox/option roles from
 * ul/li in an unsafe fix, so selection state stays visual (the combobox
 * role on the input carries `aria-expanded`); don't re-add those roles —
 * they'll just vanish on the next `bun run lint`.
 */
export function AutocompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  ariaLabel,
  className,
}: {
  /** Current text */
  value: string;
  /** Fires for typed changes and suggestion picks */
  onChange: (value: string) => void;
  /** Candidates from the harness schema (key/flag + description as detail) */
  suggestions: Suggestion[];
  /** Input placeholder */
  placeholder?: string;
  /** Accessible name for the input */
  ariaLabel: string;
  /** Extra classes for the input */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const hits = useMemo(() => filterSuggestions(value, suggestions), [value, suggestions]);
  const exact = suggestions.some((s) => s.value.toLowerCase() === value.trim().toLowerCase());
  const show = open && hits.length > 0 && !exact;

  function pick(item: Suggestion) {
    onChange(item.value);
    setOpen(false);
  }

  return (
    <div className="relative">
      <Input
        role="combobox"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-expanded={show}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % hits.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + hits.length) % hits.length);
          } else if (e.key === "Enter") {
            // Commit the highlighted suggestion instead of submitting the form.
            e.preventDefault();
            pick(hits[Math.min(active, hits.length - 1)]);
          } else if (e.key === "Escape" || e.key === "Tab") {
            setOpen(false);
          }
        }}
        className={className}
      />
      {show && (
        <ul className="absolute z-20 mt-1 max-h-44 w-full overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md">
          {hits.map((item, i) => (
            <li
              key={item.value}
              onMouseDown={(e) => {
                // preventDefault keeps the input focused so blur doesn't
                // close the list before this click registers.
                e.preventDefault();
                pick(item);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 px-2 py-1.5 text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="shrink-0 font-mono">{item.value}</span>
              {item.detail && <span className="truncate text-muted-foreground text-xs">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
