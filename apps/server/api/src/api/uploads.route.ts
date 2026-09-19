import { accessSync, constants, statSync } from "node:fs";
import { BackendErrorCodes } from "@internal/backend-errors";
import { MAX_UPLOAD_BYTES } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { isNodeOffline } from "@/services/nodes/node-registry.js";
import { RemoteUploadError, UploadError, writeUpload, writeUploadRemote } from "@/services/uploads.service.js";
import { logger } from "@/utils/logger.js";

/** Multipart body: exactly one file per request. */
const UploadBodySchema = t.Object({
  file: t.File({
    // Shared with the browser via @internal/subshell-protocol so the two caps
    // cannot drift; a drift would be silent, with the client accepting files
    // the server then refuses.
    maxSize: MAX_UPLOAD_BYTES,
    // Derived, not restated: this string is published to /docs, so a hardcoded
    // number here would ship a wrong limit the moment the cap changes.
    description: `File to store in the subshell's working directory (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`,
  }),
});

/** Path parameters for the upload endpoint. */
const UploadParamsSchema = t.Object({
  id: t.String({ description: "Subshell id to upload into" }),
});

/** Shape returned after a file is stored. */
const UploadResponseSchema = t.Object({
  path: t.String({ description: "Absolute path the harness can read the file at" }),
  name: t.String({ description: "Final on-disk filename (sanitized, timestamp-prefixed)" }),
  size: t.Number({ description: "Stored size in bytes" }),
  contentType: t.String({ description: "MIME type, sniffed from content when possible" }),
});

/**
 * Subshell file uploads.
 *
 * Files land in `<workingDir>/.subshell/uploads/` — inside the harness's cwd, so
 * an agent can read them without a permission prompt, and on a read-write
 * host mount under Docker so they are visible from the host too. The client
 * then injects the returned path into the terminal.
 *
 * For a subshell pinned to an agent node the same path is produced THERE:
 * the bytes ride the signed RPC as ordered `write_file` chunks (spec §3.4),
 * and the response shape is identical — only the filesystem differs.
 */
export const uploadsRoutes = new Elysia({ prefix: "/api/subshells" })
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/uploads",
    async ({ params, body, user, actor, status }) => {
      // F4 (security audit 2026-08): browser-only surface — the `subshell mcp`
      // binary never uploads (endpoint census: packages/mcp-core/src/tools.ts), and the
      // frontend posts cookie-only with `credentials: "include"`. A bearer
      // key writing files into the owner's working directory would feed the
      // agent's cwd, so machine actors get 403 before anything is resolved.
      if (actor !== "cookie") throw new ForbiddenError();
      const row = await new SubshellsRepository(db).findById(params.id);
      // A subshell that is not the caller's is reported as missing rather than
      // forbidden, so the endpoint never confirms another user's subshell id.
      if (!row || row.userId !== user.id) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Subshell not found" }));
      }

      const workingDir = row.workingDir;

      // Phase-2 relay (spec §3.4): a subshell pinned to an agent node stores
      // its upload THERE. The local-fs checks below are deliberately skipped
      // for this branch — that filesystem lives on the node, where the
      // node's `write_file` path policy is the authority; stat-ing a local
      // copy of the path (or refusing because this host has no such dir)
      // would be meaningless.
      if (row.nodeId !== LOCAL_NODE_ID) {
        // Pre-gate the live connection (§5.6 — the blessed `isNodeOffline`
        // predicate, same deferral rule as the auto-restart): a dead node is
        // 409 before a single chunk goes out. Mid-stream drops land in the
        // catch below.
        if (isNodeOffline(row.nodeId)) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_OFFLINE,
              message: `The subshell's node "${row.nodeId}" is offline; start it and retry`,
            }),
          );
        }
        try {
          return await writeUploadRemote(row.nodeId, workingDir, body.file);
        } catch (err) {
          if (err instanceof RemoteUploadError) {
            // The browser only ever sees the generic mapping below, so the
            // details (which chunk died, the node's refusal text, the
            // byte-count disagreement) must be captured SERVER-side or the
            // failure is undebuggable — err.message already names the chunk
            // index, and `child()` first because withContext mutates the
            // logger it is called on (see error-handler.plugin.ts).
            logger
              .child()
              .withContext({ subshellId: params.id, nodeId: row.nodeId })
              .withError(err)
              .warn(`remote upload relay to node "${row.nodeId}" failed for subshell ${params.id}`);
            // Map on the class + `offline` flag ONLY — node refusal strings
            // are unpinned protocol-side (T6 ruling), so no node text is
            // echoed; the details ride the server-side error, not the body.
            return err.offline
              ? status(
                  409,
                  apiErrorBody({
                    code: BackendErrorCodes.NODE_OFFLINE,
                    message: "The node dropped the connection mid-upload; re-run the upload",
                  }),
                )
              : status(
                  // 409, NOT 502: NODE_UNREACHABLE carries 409 everywhere else
                  // (the registry default + recheck + log-tail), and clients
                  // branch on `code` — one code must mean one status.
                  409,
                  apiErrorBody({
                    code: BackendErrorCodes.NODE_UNREACHABLE,
                    // Honest rule (spec errata, phase-2 review #7): a pane
                    // that exited NATURALLY is forgotten by the node's exit
                    // watcher, so its cwd leaves the write_file root set and
                    // re-running the upload NEVER succeeds — only a relaunch
                    // does. Do not promise a self-heal here.
                    message:
                      "The node failed to store the file; the node only accepts files for a running subshell; restart the subshell and upload again",
                  }),
                );
          }
          if (err instanceof UploadError) {
            // Local composition guard (target not absolute, etc.) — same 400
            // contract as the local branch's UploadError mapping.
            return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: err.message }));
          }
          throw err;
        }
      }

      try {
        if (!statSync(workingDir).isDirectory()) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.EXISTS_ERROR,
              message: "Subshell working directory is not a directory",
            }),
          );
        }
        accessSync(workingDir, constants.W_OK);
      } catch {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.EXISTS_ERROR,
            message: "Subshell working directory is missing or not writable",
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
        // Offline pre-gate / mid-stream drop (NODE_OFFLINE) AND the remote
        // relay failure (node accepted then refused the stream,
        // NODE_UNREACHABLE) — one code, one status, everywhere (§5.6).
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "uploadSubshellFile",
        tags: ["subshells"],
        description:
          "Stores a file in the subshell's working directory (relayed to the subshell's node when it runs on one) and returns its absolute path",
      },
    },
  );
