import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { readServerLogTail, SERVER_LOG_CAP_BYTES, serverLogPath } from "@/utils/log-file.js";

const LogsQuerySchema = t.Object({
  lines: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: 1000,
      default: 200,
      description: "How many of the newest lines to return (1..1000)",
    }),
  ),
});

const LogsResponseSchema = t.Object({
  lines: t.Array(
    t.Object({
      ts: t.String({ description: "ISO 8601 timestamp; empty for a raw line" }),
      level: t.String({ description: "Log level word, or `raw` for a line that was not JSON" }),
      message: t.String({ description: "The message" }),
      data: t.Optional(t.Unknown({ description: "Context, metadata and error fields the line carried" })),
    }),
    { description: "Oldest first" },
  ),
  file: t.String({ description: "The log file read" }),
  bytes: t.Number({ description: "The file's current size" }),
  capBytes: t.Number({ description: "Size at which the file is replaced" }),
});

/** Test seam: where the file is. @internal */
export const logsSeams = { path: serverLogPath };

/**
 * `GET /api/admin/server/logs` — the newest lines of the server's own log
 * file (spec § 3.4). Nothing is held in memory: this reads the file, which is
 * at most 200 KB by construction.
 *
 * An admin reading the server's log from a browser is a new reader of that
 * text, and in debug mode it holds request paths — `GET /install.sh?key=nsk_…`
 * puts a setup key in one. That widens nothing (the same keys already land in
 * access logs, and an admin can mint them anyway) but it is why this is
 * cookie-admin like the rest of the directory.
 */
export const logsRoute = new Elysia().use(requireAdmin).get(
  "/logs",
  async ({ query }) => {
    const path = logsSeams.path();
    const { lines, bytes } = await readServerLogTail(path, query.lines ?? 200);
    return { lines, file: path, bytes, capBytes: SERVER_LOG_CAP_BYTES };
  },
  {
    query: LogsQuerySchema,
    response: LogsResponseSchema,
    detail: {
      operationId: "readServerLogs",
      tags: ["admin"],
      description: "The server's most recent log lines, read from its capped log file. Cookie-admin only.",
    },
  },
);
