/**
 * Limits shared by the subshell upload endpoint and the browser that posts to
 * it. The client mirrors the server's cap so an oversize file is rejected
 * before it is uploaded; keeping the number in one place stops the two sides
 * drifting apart, which is silent — the client would simply start accepting
 * files the server then refuses.
 */

/**
 * Largest single file accepted by `POST /api/subshells/:id/uploads`, in bytes
 * (25 MiB).
 *
 * Elysia's `t.File({ maxSize })` accepts a plain byte count, so the backend
 * and the browser can both read this exact value rather than one using a
 * `"25m"` string and the other a literal.
 *
 * The browser additionally downscales oversized screenshots (PNG/JPEG/WebP
 * over 1 MiB, longest edge to 1568 px — see `apps/frontend/src/lib/
 * image-downscale.ts`) BEFORE posting, so this cap is the ceiling, not the
 * typical image size: the stored file's base64 rides every subsequent agent
 * turn, and full-resolution multi-MB captures are what made harnesses stall
 * once an image path entered a subshell.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
