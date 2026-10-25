import { createContext, useContext } from "react";

/** Closed-control horizontal spacing: compact for sidebars, default for forms.
 * Popup rows always share the action/context-menu density. */
export type PickerDensity = "default" | "compact";

export const PickerDensityContext = createContext<PickerDensity>("default");

/** The density of the picker this element belongs to (default outside one). */
export function usePickerDensity(): PickerDensity {
  return useContext(PickerDensityContext);
}
