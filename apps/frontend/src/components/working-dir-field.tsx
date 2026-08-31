import type { JSX } from "react";
import { DirectoryPickerInput } from "@/components/directory-picker-input";

/**
 * The working-directory field: one control for a path, however you arrive at
 * it — typed, browsed (the panel opens on focus), picked from Recent, or
 * restored from Favorites.
 *
 * It replaces the old pair of controls (a "Mount" dropdown above a separate
 * "Working directory" input), which asked people to understand a distinction
 * that never existed: choosing a mount only ever wrote its path into the
 * input below it. One field cannot pose that question.
 */
export function WorkingDirField({
  id,
  value,
  onChange,
  helper,
}: {
  /** Optional `id` for the input/label association. */
  id?: string;
  /** Current path. */
  value: string;
  /** Called with the typed, browsed or picked path. */
  onChange: (path: string) => void;
  /** Optional helper text under the field. */
  helper?: string;
}): JSX.Element {
  return (
    <DirectoryPickerInput
      id={id}
      value={value}
      onChange={onChange}
      placeholder="/home/you/my-project"
      helper={helper}
    />
  );
}
