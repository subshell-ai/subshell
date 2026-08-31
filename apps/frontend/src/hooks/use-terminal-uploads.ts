import { MAX_UPLOAD_BYTES } from "@internal/session-protocol";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FileRejection, useDropzone } from "react-dropzone";
import { injectText } from "@/lib/session-frames.js";
import {
  insertionFailedMessage,
  insertionTextFor,
  rejectionMessage,
  summarizeUploadBatch,
  uploadSessionFile,
} from "@/lib/session-uploads.js";

/**
 * Drag-and-drop plus clipboard-file paste for the session terminal.
 *
 * Files are uploaded into the session's working directory and their paths injected
 * into the terminal in one batch. `noClick`/`noKeyboard` are essential: the
 * dropzone wraps the terminal, and without them a click or Space/Enter in
 * the terminal would open a file dialog.
 *
 * Plain text pastes are left alone: react-dropzone's paste handler only
 * calls `preventDefault()` when the clipboard carries files, so a text paste
 * falls through to xterm's own paste handling untouched.
 *
 * @param args.sessionId - Session receiving the files
 * @param args.wsRef - Live session socket (used to inject the paths)
 * @param args.termRef - The attached terminal (read for bracketed-paste mode)
 */
export function useTerminalUploads({
  sessionId,
  wsRef,
  termRef,
}: {
  sessionId: string;
  wsRef: { current: WebSocket | null };
  termRef: { current: Terminal | null };
}) {
  const [pending, setPending] = useState(0);
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
      setPending((n) => n + files.length);
      try {
        // allSettled (not all): files that upload successfully are already
        // stored on the server even if another file in the batch fails, so a
        // single rejection must not discard their paths.
        const settled = await Promise.allSettled(files.map((file) => uploadSessionFile(sessionId, file)));
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
        if (mounted.current) setPending((n) => Math.max(0, n - files.length));
      }
    },
    [sessionId, termRef, wsRef],
  );

  const { getRootProps, isDragActive } = useDropzone({
    noClick: true,
    noKeyboard: true,
    maxSize: MAX_UPLOAD_BYTES,
    onDrop: (accepted: File[], rejected: FileRejection[]) => {
      void handleFiles(accepted, rejectionMessage(rejected));
    },
  });

  return {
    getRootProps,
    isDragActive,
    pending,
    error,
    dismissError: useCallback(() => setError(null), []),
  };
}
