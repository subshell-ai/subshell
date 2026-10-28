import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SavedService } from "@/hooks/use-subshell-services";
import type { SubshellAccess } from "@/types/subshell";

/**
 * Whether the pane's saved-services read is worth asking for, which is the
 * same test the badge makes before counting anything: a node that has not
 * switched previews on, or one that answered with a reason, can only produce a
 * count of 0. `preview-ports-unsupported` is the case that shows why both
 * halves matter: it arrives with `nodeEnabled: true` on every macOS pane, so
 * gating on the switch alone would keep polling a list whose result is thrown
 * away. The access half is the same idea from the other side: a `view` grantee
 * never has the ports counted, so asking for their rows is a poll with a
 * discard.
 *
 * "One predicate" is the point, and it is now literally true: this and
 * {@link unsavedPreviewItemCount} both ask {@link previewAnswerUsable}, because
 * two hand-written copies of the same condition are how a future gate added to
 * one side would silently leave the other polling or counting a list nothing
 * can be made of.
 */
function previewAnswerUsable(info: PreviewInfo | undefined): info is PreviewInfo {
  return info?.nodeEnabled === true && info.reason === undefined;
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
  if (access === "view") return info.cdpPort === null ? 0 : 1;
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
