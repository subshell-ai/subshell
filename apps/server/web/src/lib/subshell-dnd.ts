/**
 * The drag payload for "put this subshell where I'm dropping" (spec 2026-09-03
 * sidebar-quickadd §5a). A dedicated MIME is the whole safety story: the same
 * drop surfaces already receive xterm's file-upload drags and dockview's own
 * tab drags, and every handler here reacts ONLY to transfers carrying this
 * type — so neither existing gesture is touched.
 */
export const SUBSHELL_DND_TYPE = "application/x-subshell-id";

/** Stamps a dragstart with the subshell id. `text/plain` mirrors the id for debugging and future drop targets that only read text. */
export function encodeSubshellDrag(dt: DataTransfer, id: string): void {
  dt.setData(SUBSHELL_DND_TYPE, id);
  dt.setData("text/plain", id);
  dt.effectAllowed = "copy";
}

/** The dragged subshell's id, or null when the transfer is not one of ours. */
export function readSubshellDrag(dt: Pick<DataTransfer, "types" | "getData">): string | null {
  if (!Array.from(dt.types).includes(SUBSHELL_DND_TYPE)) return null;
  return dt.getData(SUBSHELL_DND_TYPE) || null;
}
