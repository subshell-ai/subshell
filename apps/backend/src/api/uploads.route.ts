import { accessSync, constants, statSync } from "node:fs";
import { BackendErrorCodes } from "@internal/backend-errors";
import { MAX_UPLOAD_BYTES } from "@internal/session-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { UploadError, writeUpload } from "@/services/uploads.service.js";

/** Multipart body: exactly one file per request. */
const UploadBodySchema = t.Object({
  file: t.File({
    // Shared with the browser via @internal/session-protocol so the two caps
    // cannot drift; a drift would be silent, with the client accepting files
    // the server then refuses.
    maxSize: MAX_UPLOAD_BYTES,
    // Derived, not restated: this string is published to /docs, so a hardcoded
    // number here would ship a wrong limit the moment the cap changes.
    description: `File to store in the session's working directory (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`,
  }),
});

/** Path parameters for the upload endpoint. */
const UploadParamsSchema = t.Object({
  id: t.String({ description: "Session id to upload into" }),
});

/** Shape returned after a file is stored. */
const UploadResponseSchema = t.Object({
  path: t.String({ description: "Absolute path the harness can read the file at" }),
  name: t.String({ description: "Final on-disk filename (sanitized, timestamp-prefixed)" }),
  size: t.Number({ description: "Stored size in bytes" }),
  contentType: t.String({ description: "MIME type, sniffed from content when possible" }),
});

/**
 * Session file uploads.
 *
 * Files land in `<workingDir>/.mote/uploads/` — inside the harness's cwd, so
 * an agent can read them without a permission prompt, and on a read-write
 * host mount under Docker so they are visible from the host too. The client
 * then injects the returned path into the terminal.
 */
export const uploadsRoutes = new Elysia({ prefix: "/api/sessions" })
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/uploads",
    async ({ params, body, user, actor, status }) => {
      // F4 (security audit 2026-08): browser-only surface — the `mote mcp`
      // binary never uploads (endpoint census: src/mcp/tools.ts), and the
      // frontend posts cookie-only with `credentials: "include"`. A bearer
      // key writing files into the owner's working directory would feed the
      // agent's cwd, so machine actors get 403 before anything is resolved.
      if (actor !== "cookie") throw new ForbiddenError();
      const row = await new SessionsRepository(db).findById(params.id);
      // A session that is not the caller's is reported as missing rather than
      // forbidden, so the endpoint never confirms another user's session id.
      if (!row || row.userId !== user.id) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Session not found" }));
      }

      const workingDir = row.workingDir;
      try {
        if (!statSync(workingDir).isDirectory()) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.EXISTS_ERROR,
              message: "Session working directory is not a directory",
            }),
          );
        }
        accessSync(workingDir, constants.W_OK);
      } catch {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.EXISTS_ERROR,
            message: "Session working directory is missing or not writable",
          }),
        );
      }

      try {
        return await writeUpload({ workingRealPath: workingDir, file: body.file });
      } catch (err) {
        if (err instanceof UploadError) {
          return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: err.message }));
        }
        throw err;
      }
    },
    {
      params: UploadParamsSchema,
      body: UploadBodySchema,
      response: {
        200: UploadResponseSchema,
        // The shared structured error body for every failure path — both the
        // handler returns above AND Elysia's body-validation failure for an
        // over-cap file (native 422 rewritten to 400 by the global handler),
        // so the 400 key describes both shapes with one type. Eden clients see
        // `code`/`errId` on the error, matching every other route.
        400: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "uploadSessionFile",
        tags: ["sessions"],
        description: "Stores a file in the session's working directory and returns its absolute path",
      },
    },
  );
