import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useIsWide } from "@/hooks/use-is-wide";

/**
 * True on a PHONE, in the only sense a layout decision may use: below the
 * tiling width AND a touch-primary pointer.
 *
 * Width alone used to make every one of these choices, and it lied in both
 * directions: a small desktop window (HiDPI scaling or ⌘+ easily puts a
 * maximised window under the tiling breakpoint in CSS pixels) paid the phone
 * layout despite holding a mouse, and the phone surfaces it handed that window
 * are worse on every count: workspace tabs you cannot drag, a header burned
 * into two rows, drawer chrome on a desktop.
 *
 * The pointer is the fact that separates the small desktop window from the
 * phone (~390 CSS pixels, a finger); requiring BOTH is what keeps a phone a
 * phone at any width. A touch tablet ABOVE the tiling width is not here, and
 * does not want the phone layout either.
 *
 * This is the shared formula behind the surfaces that used to each write
 * `!wide && coarse` themselves: `useIsStackedHeader` and the workspace
 * presentation switch (tab strip vs dock). `useHasSidebar` asks a different
 * question on purpose (its fine-pointer rule has a real lower bound of its
 * own, `SIDEBAR_MIN_WIDTH`) and must not be folded in here.
 */
export function useIsPhoneLayout(): boolean {
  const wide = useIsWide();
  const coarse = useIsCoarsePointer();
  return !wide && coarse;
}
