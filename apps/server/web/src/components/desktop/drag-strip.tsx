import { startWindowDrag } from "@/lib/desktop";

/**
 * The window's title bar, when the desktop shell has taken the real one away.
 *
 * `shell_ready` drops the native title bar on EVERY route — its own doc says
 * so, naming `/login` and `/setup` — but the strip that replaced it lived
 * inside `DesktopSidebar`, and those two routes render no sidebar. So the one
 * window a person meets first had no title bar and nothing to drag: the app
 * could only be moved by its other edges, which is not where anyone reaches.
 *
 * `startWindowDrag` rather than `data-tauri-drag-region`: that attribute only
 * works on the element it is applied to directly, and this sits above a tree
 * of nested elements that would each need it.
 */
export function DragStrip({ fixed = false }: { fixed?: boolean }) {
  return (
    <div
      // Presentation only — not focusable and not announced. A screen reader
      // has nothing to say about a drag handle it cannot use.
      aria-hidden
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // The press would otherwise begin a text selection in the page under
        // this strip — which is what put an I-beam under the pointer and left
        // stray highlighting behind a drag. A title bar is not text.
        e.preventDefault();
        startWindowDrag();
      }}
      // `fixed` for the standalone case: the rail gives this an anchor to be
      // absolute within, and a bare route has none — `absolute` there would
      // resolve against whatever ancestor happened to be positioned.
      // `cursor-default`: an empty box inherits the text cursor from the
      // content it covers, so the one strip you are meant to grab advertised
      // itself as a paragraph. `select-none` for the same press.
      className={`${fixed ? "fixed" : "absolute"} inset-x-0 top-0 z-10 h-7 cursor-default select-none`}
    />
  );
}

/**
 * Whether the frame must render a standalone strip, because the rail is not
 * there to carry one.
 *
 * The rail renders on `hasSidebar && !bare`, so this is its exact complement:
 * between them, a desktop window has one drag surface on every route and
 * never two stacked on each other. Written as a function so that complement
 * is asserted rather than left as two conditions in two files that someone
 * edits one of.
 */
export function needsStandaloneDragStrip(hasSidebar: boolean, bare: boolean): boolean {
  return !(hasSidebar && !bare);
}
