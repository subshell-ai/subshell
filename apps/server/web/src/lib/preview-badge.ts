import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SavedService } from "@/hooks/use-subshell-services";

/**
 * How many things the preview picker could offer that this pane has no saved
 * service for - the number behind the header icon's badge.
 *
 * "Saved" means a row in the pane's Saved services list, which is what the
 * person chose to keep; a discovered port with no row is something they have
 * not decided about yet. The screen and the browser watch are offered whole
 * (one item each) whenever the pane has them: nothing saves those, so the
 * badge is "there is something here you can open", and it clears with the
 * rest once the node switch or the reason says there is nothing to offer.
 * A port discovered on both IPv4 and IPv6 counts once.
 */
export function unsavedPreviewItemCount(info: PreviewInfo | undefined, services: SavedService[] | undefined): number {
  if (!info?.nodeEnabled || info.reason) return 0;
  const savedPorts = new Set((services ?? []).map((service) => service.port));
  const discoveredPorts = new Set(info.ports.map((row) => row.port));
  let count = 0;
  for (const port of discoveredPorts) {
    if (!savedPorts.has(port)) count += 1;
  }
  if (info.screen) count += 1;
  if (info.cdpPort !== null) count += 1;
  return count;
}
