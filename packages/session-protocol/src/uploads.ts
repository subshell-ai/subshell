/**
 * Limits shared by the session upload endpoint and the browser that posts to
 * it. The client mirrors the server's cap so an oversize file is rejected
 * before it is uploaded; keeping the number in one place stops the two sides
 * drifting apart, which is silent — the client would simply start accepting
 * files the server then refuses.
 */

/**
 * Largest single file accepted by `POST /api/sessions/:id/uploads`, in bytes
 * (25 MiB).
 *
 * Elysia's `t.File({ maxSize })` accepts a plain byte count, so the backend
 * and the browser can both read this exact value rather than one using a
 * `"25m"` string and the other a literal.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
