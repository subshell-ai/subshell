import { createContext, useContext } from "react";

/**
 * One density rule for every picker: a popup is the size of the control it
 * hangs off. A full-size list under a small trigger reads as a bug (the phone
 * report 2026-10-24: the sidebar's 28px workspace switcher opening 32px rows
 * dwarfed itself). Callers set `density="compact"` on the picker Root once;
 * the trigger and every row read the pairing from this context, so the two
 * halves cannot drift the way hand-matched classNames did.
 *
 * `"default"` is the form-family size — the 36px control that sits beside an
 * h-9 Input, with 32px rows (the same row height the action menus use).
 * `"compact"` is the dense-sidebar size: a 28px control with rows that fit it.
 */
export type PickerDensity = "default" | "compact";

export const PickerDensityContext = createContext<PickerDensity>("default");

/** The density of the picker this element belongs to (default outside one). */
export function usePickerDensity(): PickerDensity {
  return useContext(PickerDensityContext);
}
