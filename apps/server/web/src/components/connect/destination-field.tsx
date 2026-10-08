import { Input } from "@internal/node-admin";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { ComboboxOption } from "@/components/ui/combobox";

/**
 * The destination field: a real input, because the answer may be a host no
 * list carries, with an in-flow row panel that opens on focus. The posture
 * is the working-directory field's (`directory-picker-input.tsx`), copied
 * deliberately: a controlled input, a panel that follows its text, and an
 * outside press or Escape as the dismissal. `SearchableSelect` is NOT used
 * here on purpose - Base UI's collection reset wipes a held input's typed
 * text when its items swap mid-typing (measured and documented in
 * `ui/combobox.tsx`), and this field's items must swap on EVERY keystroke:
 * the typed mirror row is the list growing to meet what was typed.
 *
 * The list is the three fed groups (`destination-options.ts`): Saved,
 * Recent, and the picked machine's config aliases, each under its header,
 * plus the mirror row. Clicking (or pressing Enter on the top row) COMMITS
 * a row - the commitment is the candidate the launch carries, never the raw
 * echo - and typing over a committed row releases it, so the field's text
 * and the panel's truth cannot drift apart.
 */
export function DestinationField({
  id,
  describedBy,
  placeholder,
  typed,
  query,
  options,
  onTextChange,
  onPick,
}: {
  /** Input id - the Label's htmlFor and the test/e2e anchor */
  id: string;
  /** Id of the element explaining this field (the disclosure sentence) */
  describedBy?: string;
  placeholder: string;
  /** The input's text: typed free text, or the committed row's label */
  typed: string;
  /** What filters the list; "" while a committed row's echo stands */
  query: string;
  /** The full fed list (groups + mirror row); the field only filters it */
  options: readonly ComboboxOption[];
  onTextChange: (text: string) => void;
  /** Commits one row (a click, or Enter on the top visible row) */
  onPick: (option: ComboboxOption) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismissal by anything outside the field, or Escape - the directory
  // picker's rule, and the listeners live with `open` so an idle field costs
  // nothing.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The same filter the shared combobox applies, so the picker and every
  // other list in the product answer a query identically: label or searchText,
  // case-insensitive contains, trimmed.
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? [...options]
      : options.filter(
          (o) => o.label.toLowerCase().includes(needle) || (o.searchText ?? "").toLowerCase().includes(needle),
        );

  function pick(option: ComboboxOption): void {
    onPick(option);
    setOpen(false);
  }

  let lastGroup: string | undefined;
  return (
    <div ref={rootRef} className="space-y-1">
      <Input
        id={id}
        value={typed}
        onChange={(e) => onTextChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        aria-describedby={describedBy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && visible.length > 0) {
            e.preventDefault(); // committing the top row is the act; it must not submit the page
            pick(visible[0]);
          }
        }}
      />
      {open && visible.length > 0 && (
        // The id lets callers (and tests) scope to the popup: a group header
        // like "Recent" names the same word the ledger heading below uses,
        // and only the popup's copy is the picker's.
        <div
          id={`${id}-panel`}
          className="mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-background p-1 shadow-md"
        >
          {visible.map((option) => {
            const header = option.group !== undefined && option.group !== lastGroup;
            lastGroup = option.group;
            return (
              <div key={option.value}>
                {header && <div className="px-2 pt-1.5 pb-0.5 text-detail text-muted-foreground">{option.group}</div>}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()} // keep the input's focus through the press
                  onClick={() => pick(option)}
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">{option.label}</span>
                  {option.reason ? (
                    <span className="ml-auto max-w-[45%] truncate pl-3 text-detail text-muted-foreground">
                      {option.reason}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {open && visible.length === 0 && <p className="px-2 py-1.5 text-detail text-muted-foreground">No matches</p>}
    </div>
  );
}
