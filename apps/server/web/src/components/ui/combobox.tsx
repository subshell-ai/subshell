import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Fragment, type JSX, type ReactNode, useMemo, useRef, useState } from "react";

/** One row in a {@link SearchableSelect} list. */
export interface ComboboxOption {
  /** Stable option id — the picker's value */
  value: string;
  /** Text shown in the list and, when selected, in the input */
  label: string;
  /** Unselectable row (incompatible pair) — `reason` explains why */
  disabled?: boolean;
  /** Muted trailing copy on the row (a disabled row's refusal, or a detail line) */
  reason?: string;
  /** Node shown before the label (aria-hidden — the accessible name stays the label) */
  icon?: ReactNode;
  /**
   * Extra text the query is matched against, NOT shown on the row. Exists
   * for callers whose search is broader than the label (the prompt picker
   * matches description OR body, spec 2026-09-28) — without it the shared
   * filter would silently narrow those fields to label-only.
   */
  searchText?: string;
  /**
   * A category label rendered as a non-selectable header above the FIRST row
   * that carries it (the copy picker's "Recently terminated", mirroring the
   * directory picker's "Recent"). Rows sharing a group list under one header;
   * consecutive rows with the same value collapse to a single header, and the
   * header follows the FILTERED list so it shows exactly when a member of the
   * group survives the search.
   */
  group?: string;
  /**
   * Render a hairline divider ABOVE this row (the prompt picker's line between
   * "Recently used" and the rest). A bare separator, not a labelled group: no
   * category name, just the rule that says "the others start here". Non-selectable.
   */
  divider?: boolean;
}

export interface SearchableSelectProps {
  /** Id of the rendered input — labels (htmlFor) and e2e anchor on it */
  id: string;
  /** Selected option id; "" renders the placeholder */
  value: string;
  /**
   * Fired with the newly picked option's id. Disabled rows never fire it
   * (inert). `""` arrives only when Base UI reports a null selection value —
   * the primitive renders no clear affordance, so this is not a normal pick.
   */
  onValueChange: (value: string) => void;
  /** Input placeholder, also the unselected closed state */
  placeholder: string;
  options: readonly ComboboxOption[];
  /**
   * Ids of the elements that explain this field — the hint lines rendered
   * under it. Forwarded to the real <input>, because visual reading order is
   * not an association: a screen reader announces the field without them
   * unless it is told.
   */
  describedBy?: string;
  /** Shown by the popup when its list has nothing to show: no matches, or
   *  the caller's own loading/empty/failure sentence. */
  emptyText?: ReactNode;
  /**
   * When set, the UNFILTERED popup shows at most this many rows of each
   * `group` (the copy picker's "a few each, search to dig deeper"). A typed query
   * lifts the cap so a search reaches every match, not just the first few —
   * the cap is a tidy default list, never a search ceiling. Rows carry their
   * `group`; ungrouped callers pass nothing and are unaffected.
   */
  groupPreviewLimit?: number;
  /**
   * The input is a CONSUMED search (the pick is an action, the closed state is
   * the placeholder, nothing holds a selection): the typed text is owned here
   * and survives a late `items` swap, which an uncontrolled input loses to
   * Base UI's collection reset (the prompt picker's late stacks payload, the
   * round-5 review). A HELD picker must NOT pass this: its closed state shows
   * the selected label, and that echo is Base UI's behavior to own (pinning
   * it down to "" blanks the just-picked selection - the setup wizard caught
   * exactly that when this was keyed on `value === ""`).
   */
  consumed?: boolean;
}

/**
 * Searchable single-select on Base UI Combobox — the launch pickers'
 * primitive (spec 2026-09-02 §1). Unlike `select.tsx` the closed state is a
 * real <input> (type-to-filter), so callers pass their e2e-pinned id there.
 * Options are `{ value, label, searchText?, disabled?, reason? }`; the Root
 * filters label and searchText (case-insensitive contains, trimmed),
 * disabled rows stay listed with their muted reason — greying out explains
 * rather than hides.
 */
export function SearchableSelect({
  id,
  value,
  onValueChange,
  placeholder,
  options,
  describedBy,
  emptyText = "No matches",
  groupPreviewLimit,
  consumed,
}: SearchableSelectProps): JSX.Element {
  // Item values are the option objects; the external contract stays the
  // plain id string. Object identity would break under rebuilt arrays, so
  // equality compares ids.
  const selected = options.find((o) => o.value === value) ?? null;
  // The live query, OWNED here and passed back to Base UI as the controlled
  // `inputValue`. Two reasons it must be ours: the PREVIEW cap below needs to
  // know "showing everything" vs "the user is searching", and - measured
  // 2026-09-29 - an UNcontrolled input whose `items` prop changes mid-typing
  // gets wiped by Base UI's collection reset (it emits an empty
  // onInputValueChange and blanks the field, probe-verified). Controlled text
  // survives the swap: typing "Alpha4" into a capped list lifted to full
  // keeps the text and filters deep.
  const [query, setQuery] = useState("");
  const previewing = groupPreviewLimit != null && query.trim() === "";
  // The cap trims the ITEM SET the root navigates, not just what the children
  // callback paints: a row that stays in the list but renders nothing is a
  // keyboard stop that highlights invisibly (ArrowDown appears dead, Enter
  // commits nothing - round-2 review). With no query each group contributes
  // at most the cap; a typed query lifts it, so search reaches every match.
  // Ungrouped rows and cap-less callers pass through untouched.
  const visibleOptions = useMemo(() => {
    if (!previewing) return options;
    const used = new Map<string, number>();
    return options.filter((o) => {
      if (o.group == null) return true;
      const n = used.get(o.group) ?? 0;
      if (n >= (groupPreviewLimit ?? 0)) return false;
      used.set(o.group, n + 1);
      return true;
    });
  }, [options, previewing, groupPreviewLimit]);

  // The phone scroll-back (2026-09-04): focusing the type-to-filter input
  // makes a touch browser scroll it "into view" — inside a dialog that means
  // the dialog's own scroller slides (often to its bottom), and when the
  // popup is dismissed the shift STAYS, leaving the dialog header off-screen
  // (user report 2026-09-04, pinned by the 08-mobile-shell regression).
  // Record the scroller's position at pointerdown — before the focus, the
  // keyboard, and any shift — and put it back when the popup closes. The
  // dropdown covers the dialog while open, so restoring unconditionally
  // cannot trample a deliberate dialog scroll.
  const scrollerRef = useRef<{ el: Element; top: number } | null>(null);
  // Group headers are computed while the list maps top to bottom; the previous
  // row's group lives here and is reset at index 0 of EVERY pass (see the List
  // below), not per render, so a re-filter cannot carry stale state across the
  // boundary.
  let lastGroup: string | undefined;
  return (
    <ComboboxPrimitive.Root
      items={visibleOptions}
      value={selected}
      isItemEqualToValue={(a: ComboboxOption, b: ComboboxOption) => a.value === b.value}
      onValueChange={(opt: ComboboxOption | null) => onValueChange(opt?.value ?? "")}
      // Control the input when the text is OURS to own: a capped list (the
      // trim reads the query) or a consumed search (the copy picker, the
      // prompt picker) whose typed text must survive a late `items` swap,
      // which an uncontrolled input loses to Base UI's collection reset
      // (round-5 review). A held picker keeps Base UI's uncontrolled text -
      // the closed state's selected-label echo is its behavior, and pinning
      // it to "" blanks the just-picked selection (caught by the setup
      // wizard when this was keyed on `value === ""`).
      inputValue={groupPreviewLimit != null || consumed === true ? query : undefined}
      onInputValueChange={(next: string) => setQuery(next)}
      onOpenChange={(open) => {
        // A reopened capped list starts calm: the query (and with it the trim)
        // resets on close. A reopened consumed search starts empty for the
        // same reason (the pick returned the input to its placeholder); a
        // held picker keeps Base UI's own restore-the-label behavior.
        if (!open && (groupPreviewLimit != null || consumed === true)) setQuery("");
        if (open) return;
        const saved = scrollerRef.current;
        scrollerRef.current = null;
        if (saved?.el.isConnected && saved.el.scrollTop !== saved.top) saved.el.scrollTop = saved.top;
      }}
      filter={(item: ComboboxOption, query: string) => {
        // Per-field, trimmed: the same semantics the Prompts page filter
        // (matchesPromptQuery) has, so the picker and the page answer a
        // query identically. Joining the fields would match ACROSS the
        // label/body boundary the page never matches. (The PREVIEW cap is NOT
        // here: Base UI does not call this function at all while the query is
        // empty, so the cap trims `items` - see visibleOptions.)
        const q = query.trim().toLowerCase();
        if (q === "") return true;
        return item.label.toLowerCase().includes(q) || (item.searchText ?? "").toLowerCase().includes(q);
      }}
    >
      <ComboboxPrimitive.Input
        id={id}
        aria-describedby={describedBy}
        placeholder={placeholder}
        onPointerDownCapture={() => {
          // CAPTURE phase, before Base UI's own target-phase pointerdown
          // (which opens + focuses, and the focus is what shifts the
          // scroller): snapshot the nearest scroller while it still holds
          // the position the user chose — typically the Dialog's inner
          // overflow wrapper (see ui/dialog.tsx).
          const anchor = document.getElementById(id);
          const scroller = anchor?.closest('[data-slot="dialog-content"] > div') ?? document.scrollingElement;
          if (scroller) scrollerRef.current = { el: scroller, top: scroller.scrollTop };
        }}
        className="flex h-9 w-full items-center whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner align="start" sideOffset={4} className="isolate z-50">
          <ComboboxPrimitive.Popup
            data-slot="combobox-content"
            className="max-h-96 min-w-[var(--anchor-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground opacity-100 shadow-md transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <ComboboxPrimitive.List className="p-1">
              {(option: ComboboxOption, index: number) => {
                // Index 0 restarts the per-pass header detection, so a
                // re-filter cannot carry stale state across the boundary.
                if (index === 0) lastGroup = undefined;
                const header = option.group !== undefined && option.group !== lastGroup;
                lastGroup = option.group;
                return (
                  <Fragment key={option.value}>
                    {header && (
                      // role=presentation: the listbox owns only options/groups,
                      // so the label must not be an unnamed listbox child. This
                      // keeps the text for the virtual cursor without the ARIA
                      // owned-children violation (and the divider is aria-hidden).
                      <div role="presentation" className="px-2 pt-1.5 pb-0.5 text-detail text-muted-foreground">
                        {option.group}
                      </div>
                    )}
                    {option.divider && <div aria-hidden className="mx-2 my-1 border-t" />}
                    <ComboboxPrimitive.Item
                      value={option}
                      disabled={option.disabled ?? false}
                      className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-2 pl-2 text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50"
                    >
                      {option.icon !== undefined && (
                        <span aria-hidden className="mr-2 flex shrink-0 items-center">
                          {option.icon}
                        </span>
                      )}
                      <span className="truncate">{option.label}</span>
                      {option.reason ? (
                        <span className="ml-auto max-w-[45%] truncate pl-3 text-detail text-muted-foreground">
                          {option.reason}
                        </span>
                      ) : null}
                    </ComboboxPrimitive.Item>
                  </Fragment>
                );
              }}
            </ComboboxPrimitive.List>
            {/* The Empty root stays mounted while rows exist (Base UI's
                live-region doctrine) — so it carries NO box of its own: padding
                on the element was a phantom 12px strip under the last row of
                every non-empty popup (uneven bottom gap, 2026-09-28). The
                padding lives on the sentence wrapper, which renders only when
                the list is empty. */}
            <ComboboxPrimitive.Empty className="text-detail text-muted-foreground">
              <div className="px-2 py-1.5">{emptyText}</div>
            </ComboboxPrimitive.Empty>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
