import { MAX_UPLOAD_BYTES } from "@internal/subshell-protocol";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FileRejection, useDropzone } from "react-dropzone";
import { prepareForUpload } from "@/lib/image-downscale.js";
import { injectText } from "@/lib/session-frames.js";
import {
  insertionFailedMessage,
  insertionTextFor,
  MAX_CONCURRENT_UPLOADS,
  mapWithConcurrency,
  rejectionMessage,
  summarizeUploadBatch,
  uploadSessionFile,
} from "@/lib/session-uploads.js";
import { isPasteChord } from "@/lib/terminal-keys.js";

/** One in-flight upload as the overlay renders it. */
export interface UploadEntry {
  /** Stable id for this attempt (state is keyed by it, not by name — duplicates exist). */
  id: string;
  /** Display name; the ORIGINAL name until the (possibly downscaled) payload is known */
  name: string;
  /** "compressing" = pre-upload downscale; "uploading" = bytes on the wire */
  status: "compressing" | "uploading";
  /** Bytes handed to the network so far */
  sent: number;
  /** Total payload bytes, once known */
  total: number;
}

/**
 * A `paste` event carrying no files and no non-empty text. That is exactly
 * the shape Chrome/Firefox deliver when the clipboard holds an IMAGE and
 * focus sits in a plain textarea — the browsers refuse to expose image data
 * to non-contenteditable sinks, so the event looks like nothing happened.
 * Text-carrying events (the normal case) never match.
 */
function looksEmptyPaste(cd: DataTransfer): boolean {
  const types = Array.from(cd.types ?? []);
  if (types.length === 0) return true;
  return types.every((t) => t === "Files" || (t.startsWith("text/") && !cd.getData(t)));
}

/**
 * How long a Ctrl/Cmd+V gesture waits for its `paste` event before falling
 * back to the async clipboard. Generous enough that a real event always wins
 * the race (it is dispatched in the same task as the keystroke), short enough
 * to feel immediate when none is coming.
 */
const PASTE_EVENT_GRACE_MS = 150;

/** MIME → file extension for async-clipboard image entries. */
const CLIPBOARD_IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * Queries the async clipboard (only legal inside the paste user gesture) and
 * returns its image entries as timestamped Files. Throws on denial or
 * unsupported environments — the caller turns that into guidance.
 */
async function readClipboardImages(): Promise<File[]> {
  if (!navigator.clipboard?.read) throw new Error("clipboard.read unavailable");
  const out: File[] = [];
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t in CLIPBOARD_IMAGE_EXTS);
    if (!type) continue;
    const blob = await item.getType(type);
    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    out.push(new File([blob], `pasted-image-${stamp}.${CLIPBOARD_IMAGE_EXTS[type]}`, { type }));
  }
  return out;
}

/**
 * Drag-and-drop plus clipboard-file paste for the session terminal.
 *
 * Files are uploaded into the session's working directory and their paths injected
 * into the terminal in one batch. `noClick`/`noKeyboard` are essential: the
 * dropzone wraps the terminal, and without them a click or Space/Enter in
 * the terminal would open a file dialog.
 *
 * Oversized screenshots are downscaled in the browser first (see
 * `lib/image-downscale`) — the file the harness later Reads must stay small,
 * because its base64 rides every subsequent model turn.
 *
 * Clipboard FILES are owned here, not by react-dropzone (its `noPaste` is
 * set): xterm binds `paste` on its own textarea and consumes the event
 * before any bubble-phase document listener can act — so in a PWA the
 * keystroke used to reach the harness CLI, which then read the SERVER's
 * (empty) clipboard and answered "no image in the clipboard" (2026-09-01
 * report). We intercept in CAPTURE phase on `document`, scoped to the root
 * whose subtree holds focus: a workspace's paste goes to the focused pane
 * only, other page inputs are untouched, and a TEXT paste (no files) falls
 * through to xterm exactly as before. A `paste` event needs no clipboard
 * permission in any browser/PWA context — unlike `navigator.clipboard.read`.
 *
 * Three routes cover the Ctrl/Cmd+V gesture, in falling order of preference —
 * because what a browser delivers for an image-only clipboard differs by
 * engine, and the ones that deliver nothing used to leave the gesture
 * unhandled:
 *
 * 1. `paste` event WITH files (`files`, or WebKit's `items`) → upload; no
 *    permission needed.
 * 2. `paste` event that is EMPTY (Chrome/Firefox image into a textarea) →
 *    `clipboard.read()` inside the gesture; one permission prompt per site.
 * 3. NO `paste` event within {@link PASTE_EVENT_GRACE_MS} → same async read,
 *    driven off the keydown. Without this the gesture is silently dropped.
 *
 * A text-carrying event stops at (1)/(2) and never reaches the async
 * clipboard, so ordinary text paste stays permissionless. The terminal
 * separately stops xterm from encoding the chord as `\x16`
 * (`session-terminal.tsx`) — otherwise the pane's own CLI answers the
 * keystroke by reading the SERVER's clipboard, which is what put "No image
 * found in clipboard" on the user's screen while their image never left the
 * browser (2026-09-02 report).
 *
 * @param args.sessionId - Session receiving the files
 * @param args.wsRef - Live session socket (used to inject the paths)
 * @param args.termRef - The attached terminal (read for bracketed-paste mode)
 * @param args.enabled - Gate for the clipboard-paste interception (follows `showUploads`)
 */
export function useTerminalUploads({
  sessionId,
  wsRef,
  termRef,
  enabled = true,
}: {
  sessionId: string;
  wsRef: { current: WebSocket | null };
  termRef: { current: Terminal | null };
  enabled?: boolean;
}) {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // An upload can outlive the component: the user navigates away or the
  // session panel unmounts while a drop is still in flight. The request keeps
  // going deliberately — the file should still land on the server — so only the
  // state writes that follow it are gated.
  //
  // This is defensive documentation, not a bug fix: React 18 removed the
  // "can't update an unmounted component" warning, so on React 19 a setState
  // after unmount is a silent no-op and leaks nothing. The guard makes the
  // intent explicit rather than repairing a defect.
  //
  // Note the two side effects after the await that are intentionally NOT
  // gated: `injectText` (the paths should land if the socket is still open) and
  // `term?.focus()`. Leave them unguarded.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Rewrites one entry in place (no-op once it left the list). */
  const patchEntry = useCallback((id: string, patch: (entry: UploadEntry) => UploadEntry) => {
    if (!mounted.current) return;
    setEntries((prev) => prev.map((e) => (e.id === id ? patch(e) : e)));
  }, []);

  const removeEntries = useCallback((ids: string[]) => {
    if (!mounted.current) return;
    const gone = new Set(ids);
    setEntries((prev) => prev.filter((e) => !gone.has(e.id)));
  }, []);

  const handleFiles = useCallback(
    async (files: File[], rejectionMsg: string) => {
      if (files.length === 0) {
        // Nothing to upload, but a dropzone rejection may still need reporting
        // (e.g. every file in the drop was oversize).
        setError(rejectionMsg || null);
        return;
      }
      // Only clear a stale error when this drop has nothing of its own to
      // report yet — a mixed drop's rejection message must survive until the
      // upload settles, not get wiped by this fresh start.
      if (!rejectionMsg) setError(null);
      const batch = files.map((file, i) => ({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        status: "compressing" as const,
        sent: 0,
        total: file.size,
      }));
      setEntries((prev) => [...prev, ...batch]);
      try {
        // Bounded pool (not allSettled-over-everything): N files show their own
        // progress lines from the first tick, MAX_CONCURRENT_UPLOADS at a time,
        // without saturating the connection. Results still come back settled,
        // in input order — a single rejection must not discard the paths of
        // files that already landed on the server.
        const settled = await mapWithConcurrency(batch, MAX_CONCURRENT_UPLOADS, async ({ id }, i) => {
          const prepared = await prepareForUpload(files[i]);
          patchEntry(id, (e) => ({ ...e, name: prepared.name, status: "uploading", total: prepared.size, sent: 0 }));
          return uploadSessionFile(sessionId, prepared, (sent, total) =>
            patchEntry(id, (e) => ({ ...e, sent, total: total || e.total })),
          );
        });
        const attempts = files.map((file, i) => ({ name: file.name, result: settled[i] }));
        const { paths, error: summaryError } = summarizeUploadBatch(attempts, rejectionMsg);

        let finalError = summaryError;
        if (paths.length > 0) {
          const term = termRef.current;
          const bracketed = term?.modes.bracketedPasteMode ?? false;
          // One injection for the whole batch so multi-file drops land atomically.
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            injectText(wsRef.current, insertionTextFor(paths, bracketed), bracketed);
            term?.focus();
          } else {
            // The socket closed (e.g. mid-reconnect) between upload and
            // injection: the files are safely stored, but silently dropping
            // the insertion would look like the whole drop did nothing.
            const note = insertionFailedMessage(paths);
            finalError = finalError ? `${finalError}; ${note}` : note;
          }
        }
        if (mounted.current) setError(finalError);
      } finally {
        removeEntries(batch.map((b) => b.id));
      }
    },
    [sessionId, termRef, wsRef, patchEntry, removeEntries],
  );

  const { getRootProps, isDragActive, rootRef } = useDropzone({
    noClick: true,
    noKeyboard: true,
    // Files from the clipboard are handled by the capture-phase listener
    // below — xterm eats the paste event before dropzone's bubble listener
    // could run, which is what made PWA image pastes fall through to the
    // harness CLI (see the hook doc).
    noPaste: true,
    maxSize: MAX_UPLOAD_BYTES,
    onDrop: (accepted: File[], rejected: FileRejection[]) => {
      void handleFiles(accepted, rejectionMessage(rejected));
    },
  });

  /**
   * Reads clipboard images inside the current gesture and uploads them,
   * turning a denial into on-screen guidance. Shared by the `paste`
   * interceptor and the keydown fallback below.
   */
  const uploadClipboardImages = useCallback(async (): Promise<void> => {
    try {
      const images = await readClipboardImages();
      if (images.length > 0) {
        await handleFiles(images, "");
        return;
      }
      // Permission granted, clipboard readable, no image in it — say so
      // plainly instead of leaving a silent no-op. (A screenshot tool's
      // "copy" puts image/png; a file manager's "copy" puts a URI list that
      // no browser exposes as an image at all — drag the file in instead.)
      setError("No image on the clipboard — copy an image, or drag the file onto the terminal.");
    } catch {
      setError(
        "Clipboard access was blocked. Click the padlock in the address bar → Site settings → Clipboard → Allow, then paste again. (Dragging the file onto the terminal always works.)",
      );
    }
  }, [handleFiles]);

  useEffect(() => {
    if (!enabled) return;
    /**
     * Set on a Ctrl/Cmd+V keydown and cleared by the `paste` event it should
     * produce. If it survives {@link PASTE_EVENT_GRACE_MS}, this browser
     * fired NO paste event for the gesture — so the async clipboard is the
     * only route left and nothing else will run it.
     */
    let awaitingPasteEvent = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    /** Whether the terminal that owns THIS hook holds focus (workspace panes each mount one). */
    const focusedHere = (): boolean => {
      const root = rootRef.current;
      const active = document.activeElement;
      return !!root && !!active && root.contains(active);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isPasteChord(e) || !focusedHere()) return;
      // The terminal suppresses xterm's \x16 for this chord (see
      // session-terminal.tsx), so the pane never sees the keystroke and the
      // browser's paste pipeline owns it. Arm the no-event fallback.
      awaitingPasteEvent = true;
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        if (!awaitingPasteEvent) return;
        awaitingPasteEvent = false;
        // Still inside the gesture's transient activation (~5 s in Chrome),
        // so `clipboard.read()` is legal here.
        void uploadClipboardImages();
      }, PASTE_EVENT_GRACE_MS);
    };

    const onPaste = (e: ClipboardEvent): void => {
      // The browser DID deliver an event — disarm the no-event fallback
      // before any early return below, or a text paste would trigger a
      // clipboard read (and its permission prompt) it never needed.
      awaitingPasteEvent = false;
      clearTimeout(graceTimer);
      // Focus-scoped: only the terminal whose subtree holds focus claims
      // the paste (workspace panes each mount this hook; page inputs must
      // keep their native paste).
      if (!focusedHere()) return;
      const cd = e.clipboardData;
      if (!cd) return;
      let files = Array.from(cd.files ?? []);
      if (files.length === 0 && cd.items?.length > 0) {
        // WebKit (iOS PWA/Safari) resolves clipboard images into `items`
        // while leaving the legacy `files` list empty — the event looks like
        // a text paste there, the keystroke fell through to the harness CLI,
        // and the CLI read the SERVER's clipboard ("no image in the
        // clipboard", 2026-09-01 report). The live `items` list is the
        // portable source; `files` is only its eagerly-resolved subset.
        files = Array.from(cd.items)
          .filter((it) => it.kind === "file")
          .map((it) => it.getAsFile())
          .filter((f): f is File => f !== null);
      }
      if (files.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void handleFiles(files, "");
        return;
      }
      // Chrome and Firefox hand a clipboard IMAGE to the DOM `paste` event
      // ONLY for contenteditable sinks — xterm's helper is a plain textarea,
      // so the event arrives empty and xterm swallows the keystroke
      // ("pasting an image does nothing", 2026-09-01 report; react-dropzone
      // v20 reads pasted files through the async clipboard for the same
      // reason — that is the one-time permission prompt seen once). An EMPTY
      // event therefore queries the real clipboard inside this user gesture
      // (`clipboard.read()`, asked once per site). A text-carrying event
      // never reaches this branch — text paste is untouched, permissionless.
      if (!looksEmptyPaste(cd)) return;
      e.preventDefault();
      e.stopPropagation();
      void uploadClipboardImages();
    };
    // Capture on `document` runs before xterm's textarea handler (target
    // phase), so interception is deterministic in every browser/PWA shell.
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("keydown", onKeyDown, true);
      clearTimeout(graceTimer);
    };
  }, [enabled, rootRef, uploadClipboardImages, handleFiles]);

  /**
   * Opens the OS image picker (camera/photos on phones and tablets, a normal
   * filtered dialog on desktop) and feeds the picks through the SAME
   * upload-and-inject path as a drag-and-drop. The dropzone's `open()` is not
   * used: react-dropzone v20 takes no per-open accept override, and filtering
   * the dropzone itself would narrow paste/drop too — images-only belongs to
   * THIS button, not to the desktop gestures.
   */
  const openImagePicker = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    // The element is disposable: once the picker resolves (or is cancelled)
    // it is dropped; the File objects it produced outlive it via handleFiles.
    input.addEventListener("change", () => {
      const files = input.files ? Array.from(input.files) : [];
      void handleFiles(files, "");
    });
    input.click();
  }, [handleFiles]);

  return {
    getRootProps,
    isDragActive,
    /** The dropzone root element — the paste interceptor scopes focus to it. */
    rootRef,
    openImagePicker,
    /** Live per-file upload state; `length` is the in-flight count. */
    entries,
    error,
    dismissError: useCallback(() => setError(null), []),
  };
}
