import { CornerDownRight, MoveHorizontal, MoveVertical } from "lucide-react";
import type { JSX } from "react";
import { Segmented } from "@/components/ui/segmented";
import type { SplitDirection } from "@/types/workspace";

/** The three placements the add-session dialog offers, in display order. */
const CHOICES: { direction: SplitDirection; label: string; icon: JSX.Element }[] = [
  { direction: "right", label: "Split right", icon: <MoveHorizontal className="h-4 w-4" /> },
  { direction: "below", label: "Split down", icon: <MoveVertical className="h-4 w-4" /> },
  { direction: "within", label: "As a tab", icon: <CornerDownRight className="h-4 w-4" /> },
];

/**
 * Chooses where an added session lands.
 *
 * A single control above the list, rather than the three parallel submenus
 * this replaces: with one list to search, the placement is a property of the
 * add, not three different lists of the same sessions.
 */
export function DirectionSelect({
  value,
  onChange,
}: {
  value: SplitDirection;
  onChange: (direction: SplitDirection) => void;
}): JSX.Element {
  return (
    <Segmented
      ariaLabel="Where to add the session"
      options={CHOICES.map((choice) => ({ value: choice.direction, label: choice.label, icon: choice.icon }))}
      value={value}
      onChange={onChange}
    />
  );
}
