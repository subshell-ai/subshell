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
  dt.effectAllowed = "copyMove";
}

/**
 * True when a transfer carries our MIME. The one gate every drop surface
 * checks, so xterm's file uploads and dockview's tab drags stay untouched.
 * `Array.from` because the real `types` is a readonly array-like, and the
 * tests' transfer stubs hand over a plain array; either way it reads.
 */
export function acceptsSubshellDrag(dt: Pick<DataTransfer, "types">): boolean {
  return Array.from(dt.types).includes(SUBSHELL_DND_TYPE);
}

/** The dragged subshell's id, or null when the transfer is not one of ours. */
export function readSubshellDrag(dt: Pick<DataTransfer, "types" | "getData">): string | null {
  if (!acceptsSubshellDrag(dt)) return null;
  return dt.getData(SUBSHELL_DND_TYPE) || null;
}

/** Snapshot only the row, excluding its child tree and destination overlays.
 *  Returned detached and unpositioned: the HTML5 path parks it off-screen for
 *  the capture, the pointer path floats it under the cursor. */
export function cloneRowSnapshot(row: HTMLElement): HTMLElement {
  const preview = row.cloneNode(true) as HTMLElement;
  preview.removeAttribute("id");
  preview.classList.add("bg-card");
  Object.assign(preview.style, {
    position: "fixed",
    width: `${row.getBoundingClientRect().width}px`,
    height: `${row.getBoundingClientRect().height}px`,
    margin: "0",
  });
  preview.setAttribute("aria-hidden", "true");
  return preview;
}

/** The dragged row's live appearance, snapped by the browser for the drag image. */
export function setSubshellDragImage(dt: DataTransfer, row: HTMLElement, clientX: number, clientY: number): void {
  if (!dt.setDragImage) return;
  const bounds = row.getBoundingClientRect();
  const preview = cloneRowSnapshot(row);
  preview.style.left = "-10000px";
  preview.style.top = "0";
  document.body.append(preview);
  dt.setDragImage(preview, Math.max(0, clientX - bounds.left), Math.max(0, clientY - bounds.top));
  // The browser captures its image after dragstart returns.
  setTimeout(() => preview.remove(), 0);
}
