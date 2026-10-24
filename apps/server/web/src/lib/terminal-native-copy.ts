import type { Terminal } from "@xterm/xterm";

/**
 * Copy mode (issue 242, touch) selects with the BROWSER's long-press
 * selection, and xterm's own copy handler never gets the event: it acts only
 * when ITS selection service holds a range, which the copy-mode shield makes
 * impossible. What reached the clipboard was the DOM's own serialization of
 * the rows — a newline at every LAYOUT break — so a soft-wrapped URL copied
 * in dead fragments and a wrapped command pasted as two half commands. This
 * module rebuilds the string at copy time from the buffer's `isWrapped`
 * facts, the same truth xterm's `getSelection` consults: seams contribute
 * nothing, real line breaks contribute CRLF.
 *
 * The row SLICES come from the DOM (that is where the selection lives), but
 * every row's WRAP FACT comes from the buffer, so the join stays exact where
 * painted text and buffer disagree about trailing blanks.
 */

/** One selected row: the text selected inside it, and the buffer's fact of whether it continues the row above. */
export interface SelectionRow {
  /** Exactly the selected text within this row (not the whole row). */
  text: string;
  /** `getLine(...).isWrapped` — this row continues the row above it. */
  wrapped: boolean;
}

/**
 * Join selected rows the way the terminal means them. A continuation row
 * (soft-wrapped by layout) attaches to what came before with nothing between
 * it; a row that does not continue contributes `eol` first. The FIRST row's
 * own wrap flag never applies: its predecessor is not part of the selection.
 *
 * @param rows - the selected rows, top to bottom
 * @param eol - terminator for real line breaks; CRLF is the terminal's own
 *   line ending, and a CRLF-terminated command pastes clean at a prompt.
 *   (xterm's own copy joins with CRLF on Windows and LF elsewhere; this
 *   joiner is the copy-mode surface, which has no desktop copy to byte-match
 *   and one answer is simpler than a platform split.)
 */
export function joinSelectionRows(rows: SelectionRow[], eol = "\r\n"): string {
  let out = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > 0 && !row.wrapped) out += eol;
    out += row.text;
  }
  return out;
}

/** The text `range` selects inside `root`, node by node. A text node fully
 * inside the range contributes everything; a node holding a range boundary
 * contributes its sliced middle; a node the range misses contributes nothing.
 * Boundary points that land on an ELEMENT (some browsers normalize a
 * line-end drag that way) leave the preceding text node fully outside the
 * range, so `intersectsNode` already skips it. */
function selectedTextOf(range: Range, root: Element): string {
  // SHOW_TEXT means every node this walk yields IS text; the DOM lib's
  // nextNode is typed to the whole Node union, hence the narrow on read.
  const walk = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let out = "";
  for (let found = walk.nextNode(); found !== null; found = walk.nextNode()) {
    const node = found as Text;
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end > start) out += node.data.slice(start, end);
  }
  return out;
}

/** The selected rows in visual order, each paired with its buffer row's
 * `isWrapped`. The DOM renderer's row container holds exactly the viewport's
 * rows, in order, so row `i` of the grid is buffer line `viewportY + i` —
 * the same mapping the tap path uses for the same reason. A row inside the
 * selection contributes its text even when empty: a blank line the user
 * selected over IS part of the copy. */
function selectedRows(term: Terminal, range: Range): SelectionRow[] {
  const grid = term.element?.querySelector(".xterm-rows");
  if (!grid) return [];
  const buffer = term.buffer.active;
  const rows: SelectionRow[] = [];
  for (let i = 0; i < grid.children.length; i++) {
    const rowEl = grid.children[i]!;
    if (!range.intersectsNode(rowEl)) continue;
    rows.push({
      text: selectedTextOf(range, rowEl),
      wrapped: buffer.getLine(buffer.viewportY + i)?.isWrapped === true,
    });
  }
  return rows;
}

/**
 * Rewrites browser-native copies made inside this terminal so they carry the
 * joined text, and installs nothing else about selection: the mode's CSS and
 * shield already own that.
 *
 * The listener rides DOCUMENT (bubble), a rung ABOVE xterm's own copy
 * listener — that one binds the terminal's element, deeper in the tree, so
 * it runs first and prevents whenever its own selection service holds a
 * range. The desktop drag-copy path is therefore untouched: a prevented
 * event is answered exactly as before. What survives to this listener is a
 * native selection, which only copy mode's `user-select: text` lets anyone
 * make. Document rather than `container` because a browser copy of page
 * text can target `body` (with nothing focused inside the terminal), and
 * such an event bubbles AWAY from a container listener instead of through
 * it; the containment check on the selection keeps the scope exactly as
 * narrow. `text/plain` only — the seam truth is about text, and a styled
 * copy of a terminal grid is nobody's feature.
 *
 * @param term - the live terminal whose buffer answers the wrap facts
 * @param container - the element xterm was opened into; an ancestor of the
 *                    rows the selection can reach
 * @returns a disposer that removes the listener
 */
export function attachNativeCopyJoin(term: Terminal, container: HTMLElement): () => void {
  const onCopy = (event: Event): void => {
    const copy = event as ClipboardEvent;
    // Prevented means xterm copied its own selection; no clipboardData means
    // nothing we could write anyway. Both keep the browser's behavior.
    if (copy.defaultPrevented || !copy.clipboardData) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    // A selection reaching into the surrounding page from the terminal (or
    // vice versa) is the browser's copy, not the pane's.
    if (!container.contains(range.commonAncestorContainer)) return;
    const rows = selectedRows(term, range);
    if (rows.length === 0) return;
    copy.clipboardData.setData("text/plain", joinSelectionRows(rows));
    copy.preventDefault();
  };
  const doc = container.ownerDocument;
  doc.addEventListener("copy", onCopy);
  return () => doc.removeEventListener("copy", onCopy);
}
