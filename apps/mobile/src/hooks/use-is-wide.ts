import { useWindowDimensions } from "react-native";
import { isWide } from "@/lib/breakpoints";

/**
 * The one breakpoint (spec §Adaptive layout): wide ≥ 1024 px, inherited from
 * the web's WORKSPACE_TILING_MIN_WIDTH via lib/breakpoints. iPad portrait is
 * phone-shaped, landscape is not, and Split View re-layouts live because
 * useWindowDimensions tracks the container, not the device.
 */
export function useIsWide(): boolean {
  return isWide(useWindowDimensions().width);
}
