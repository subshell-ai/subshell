/** One file rejected by the dropzone, narrowed to what the message needs. */
interface UploadRejection {
  /** The rejected file, narrowed to its name */
  file: { name: string };
  /** Reasons the file was rejected (e.g. size, type) */
  errors: readonly { message: string }[];
}

/**
 * Uploads one file into a session's working directory.
 *
 * @param sessionId - Session to upload into
 * @param file - The file to store
 * @returns The absolute path the harness can read the file at
 * @throws Error carrying the API's message when the upload is refused
 */
export async function uploadSessionFile(sessionId: string, file: File): Promise<string> {
  const body = new FormData();
  body.set("file", file);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
    method: "POST",
    body,
    credentials: "include",
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((j: { message?: string }) => j.message)
      .catch(() => null);
    throw new Error(message ?? `Upload failed (${res.status})`);
  }
  const json = (await res.json()) as { path: string };
  return json.path;
}

/**
 * Builds the text injected into the terminal after an upload.
 *
 * The server sanitizes filenames so none contains whitespace, but the
 * working directory they're joined onto is not guaranteed whitespace-free (see
 * `validateWorkingDir` — its `quote()` helper anticipates spacey
 * working directory paths). So a single path never needs a separator, but multiple
 * paths need one that can't be confused with a space inside the working directory
 * prefix.
 *
 * When `multiline` is true (bracketed paste is active), paths are
 * newline-joined: inside bracketed-paste markers a newline is inserted as
 * literal text rather than submitting the prompt, so this is unambiguous.
 * Otherwise paths are space-joined: without bracketed paste a newline would
 * submit the prompt instead, so space-joining is the only usable fallback,
 * accepting the residual ambiguity of a spacey working directory plus a
 * multi-file drop.
 *
 * @param paths - Absolute paths of the stored files
 * @param multiline - Whether bracketed paste is active, so newlines can be
 *   used to join multiple paths instead of spaces
 * @returns Text to inject, or "" when there is nothing to insert
 */
export function insertionTextFor(paths: string[], multiline: boolean): string {
  if (paths.length === 0) return "";
  const separator = multiline ? "\n" : " ";
  return `${paths.join(separator)} `;
}

/**
 * Flattens dropzone rejections into one human-readable line.
 *
 * @param rejections - Rejections reported by react-dropzone
 * @returns A single-line summary, or "" when nothing was rejected
 */
export function rejectionMessage(rejections: readonly UploadRejection[]): string {
  if (rejections.length === 0) return "";
  return rejections.map((r) => `${r.file.name}: ${r.errors.map((e) => e.message).join(", ")}`).join("; ");
}

/** One file's upload attempt: its name (for error naming) and settled outcome. */
export interface UploadAttempt {
  /** Original file name, used to name the file in a failure message */
  name: string;
  /** Settled result of `uploadSessionFile` for this file */
  result: PromiseSettledResult<string>;
}

/** What a batch of upload attempts resolves to: what to insert, and what to report. */
export interface UploadBatchSummary {
  /** Absolute paths of files that uploaded successfully, in attempt order */
  paths: string[];
  /** Combined message covering dropzone rejections and upload failures, or null when there's nothing to report */
  error: string | null;
}

/**
 * Summarizes one batch of upload attempts together with any files the
 * dropzone rejected before the upload began (e.g. oversize files).
 *
 * A partial failure keeps the successful paths rather than discarding them:
 * those files are already stored on the server by the time any other file
 * in the batch fails, so losing their paths would orphan them in the
 * working directory with no way for the user or agent to find them. Dropzone
 * rejections and upload failures are combined into one message so a mixed
 * drop (a valid file alongside a rejected one) still reports the rejection.
 *
 * @param attempts - One entry per file that was actually uploaded
 * @param rejectionMsg - Message for files the dropzone rejected before
 *   upload began (from `rejectionMessage`), or "" if none were rejected
 * @returns The paths to insert, and a combined error message or null
 */
export function summarizeUploadBatch(attempts: readonly UploadAttempt[], rejectionMsg: string): UploadBatchSummary {
  const paths: string[] = [];
  const failures: string[] = [];
  for (const { name, result } of attempts) {
    if (result.status === "fulfilled") {
      paths.push(result.value);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : "Upload failed";
      failures.push(`${name}: ${message}`);
    }
  }
  const messages = [rejectionMsg, ...failures].filter(Boolean);
  return { paths, error: messages.length > 0 ? messages.join("; ") : null };
}

/**
 * Builds the message shown when files uploaded successfully but their paths
 * could not be inserted because the session socket was closed (e.g.
 * mid-reconnect). The files remain safely stored in the working directory; this only
 * surfaces that the insertion step didn't happen, instead of the drop
 * silently appearing to do nothing.
 *
 * @param paths - Absolute paths of the files that uploaded but weren't inserted
 * @returns A one-line message naming the stored paths
 */
export function insertionFailedMessage(paths: string[]): string {
  return `Uploaded but the session isn't connected, so nothing was inserted: ${paths.join(" ")}`;
}
