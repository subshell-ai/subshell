import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SavedService } from "@/hooks/use-subshell-services";
import type { SubshellAccess } from "@/types/subshell";

/**
 * Whether the pane's answer can offer anything at all. A reason normally
 * means no rows, but `preview-ports-unsupported` coexists with harness
 * reported ports: the node can't scan its process tree, yet an agent can
 * still have started a server. Both the badge and the saved-services poll
 * ask this predicate, because the list is what tells a reported port apart
 * from one the person already saved.
 */
function previewAnswerUsable(info: PreviewInfo | undefined): info is PreviewInfo {
  return info?.nodeEnabled === true && (info.reason === undefined || info.ports.some((row) => row.reported === true));
}

export function shouldPollSavedServices(info: PreviewInfo | undefined, access: SubshellAccess): boolean {
  return access !== "view" && previewAnswerUsable(info);
}

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
 *
 * "Could open" is the caller's, not the pane's: a `view` grantee is refused
 * the app-port and screen rows by the picker itself (spec §6 and §7, opening
 * is `edit`), so a number counting them would invite a press that answers
 * "needs edit access" beside the very row it promised. Browser watch is the
 * one act `view` keeps, and the only thing counted for it.
 */
export function unsavedPreviewItemCount(
  info: PreviewInfo | undefined,
  services: SavedService[] | undefined,
  access: SubshellAccess,
): number {
  if (!previewAnswerUsable(info)) return 0;
  const webEnabled = info.webPreviewsEnabled !== false;
  if (access === "view") return webEnabled && info.cdpPort !== null ? 1 : 0;
  const savedPorts = new Set((services ?? []).map((service) => service.port));
  const discoveredPorts = new Set(webEnabled ? info.ports.map((row) => row.port) : []);
  let count = 0;
  for (const port of discoveredPorts) {
    if (!savedPorts.has(port)) count += 1;
  }
  if (info.screen && info.virtualDisplayEnabled !== false) count += 1;
  if (webEnabled && info.cdpPort !== null) count += 1;
  return count;
}
