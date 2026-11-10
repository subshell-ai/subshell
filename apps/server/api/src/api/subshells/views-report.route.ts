import { capUtf16, normalizeLabel, PREVIEW_PAGE_TITLE_MAX_LENGTH } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { REPORTED_PREVIEWS_MAX, reportedPreviews } from "@/modules/subshells/reported-previews.js";
import { HttpError } from "@/shared/errors.js";

const ReportBodySchema = t.Object({
  ports: t.Array(
    t.Object({
      port: t.Integer({ minimum: 1, maximum: 65_535, description: "Loopback port the harness is serving" }),
      title: t.Optional(
        t.String({
          // The schema counts UTF-16 units while the stored cap counts code
          // points, so this bound leaves room for a 200-code-point emoji
          // title; the handler caps the units before storing it.
          maxLength: PREVIEW_PAGE_TITLE_MAX_LENGTH * 2,
          description: "One-line label from the harness, usually the URL line",
        }),
      ),
    }),
    {
      maxItems: REPORTED_PREVIEWS_MAX,
      description: "Ports the harness is serving right now; the server merges them with the last report",
    },
  ),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/**
 * `POST /api/subshells/:id/views/report`: preview ports a harness discovered
 * in its own tooling. Discovery walks the pane's process tree, which a
 * harness brokering its tool shells elsewhere leaves; the harness reports the
 * ports instead.
 *
 * This is the fifth harness self-report surface (with attention,
 * harness-session, exit, and subagents): the route accepts ONLY the
 * subshell's own key, checked before any row is read. It stores ports, never
 * addresses, so it cannot direct the proxy anywhere but loopback. State is
 * in-memory and transient: a plane or pane restart starts from nothing and
 * the harness re-reports.
 */
export const viewsReportRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/views/report",
    async ({ params, body, actor, principal, apiKeyId, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      if (actor !== "subshell-key" || principal !== `sess:${params.id}`) {
        throw new HttpError(403, "Only a subshell's own key may report its preview ports");
      }
      const row = await ctx.repos.subshells.findById(params.id);
      // Restart may rotate the key while authentication is in flight.
      if (!row || row.apiKeyId !== apiKeyId) throw new HttpError(403, "This subshell key is no longer current");
      if (row.status !== "running" || row.alive !== 1) throw new HttpError(409, "This subshell is no longer running");
      reportedPreviews(ctx.db).report(
        row.id,
        row.startedAt ?? "",
        body.ports.map((entry) => {
          const title =
            entry.title === undefined
              ? ""
              : capUtf16(normalizeLabel(entry.title, PREVIEW_PAGE_TITLE_MAX_LENGTH), PREVIEW_PAGE_TITLE_MAX_LENGTH);
          return { port: entry.port, ...(title ? { title } : {}) };
        }),
      );
      return { ok: true };
    },
    {
      body: ReportBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "reportSubshellPreviewPorts",
        tags: ["subshells"],
        description: "Harness self-report of the loopback ports its own tooling serves (the pane's own key only)",
      },
    },
  );
