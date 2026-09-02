import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { JSX } from "react";

/** One row in a {@link SearchableSelect} list. */
export interface ComboboxOption {
  /** Stable option id — the picker's value */
  value: string;
  /** Text shown in the list and, when selected, in the input */
  label: string;
  /** Unselectable row (incompatible pair) — `reason` explains why */
  disabled?: boolean;
  /** Muted trailing copy on a disabled row */
  reason?: string;
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
}

/**
 * Searchable single-select on Base UI Combobox — the launch pickers'
 * primitive (spec 2026-09-02 §1). Unlike `select.tsx` the closed state is a
 * real <input> (type-to-filter), so callers pass their e2e-pinned id there.
 * Options are `{ value, label, disabled?, reason? }`; the Root filters by
 * label (case-insensitive contains), disabled rows stay listed with their
 * muted reason — greying out explains rather than hides.
 */
export function SearchableSelect({
  id,
  value,
  onValueChange,
  placeholder,
  options,
}: SearchableSelectProps): JSX.Element {
  // Item values are the option objects; the external contract stays the
  // plain id string. Object identity would break under rebuilt arrays, so
  // equality compares ids.
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <ComboboxPrimitive.Root
      items={options}
      value={selected}
      isItemEqualToValue={(a: ComboboxOption, b: ComboboxOption) => a.value === b.value}
      onValueChange={(opt: ComboboxOption | null) => onValueChange(opt?.value ?? "")}
      filter={(item: ComboboxOption, query: string) => item.label.toLowerCase().includes(query.toLowerCase())}
    >
      <ComboboxPrimitive.Input
        id={id}
        placeholder={placeholder}
        className="flex h-9 w-full items-center whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner align="start" sideOffset={4} className="isolate z-50">
          <ComboboxPrimitive.Popup
            data-slot="combobox-content"
            className="max-h-96 min-w-[var(--anchor-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground opacity-100 shadow-md transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <ComboboxPrimitive.List className="p-1">
              {(option: ComboboxOption) => (
                <ComboboxPrimitive.Item
                  key={option.value}
                  value={option}
                  disabled={option.disabled ?? false}
                  className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-2 pl-2 text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50"
                >
                  <span className="truncate">{option.label}</span>
                  {option.reason ? (
                    <span className="ml-auto max-w-[45%] truncate pl-3 text-muted-foreground text-xs">
                      {option.reason}
                    </span>
                  ) : null}
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
            <ComboboxPrimitive.Empty className="px-2 py-1.5 text-muted-foreground text-sm">
              No matches
            </ComboboxPrimitive.Empty>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
