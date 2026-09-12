import { elysiaLogLayer } from "@loglayer/elysia";
import { Elysia } from "elysia";
import type { LogLayer } from "loglayer";
import { nanoid } from "nanoid";
import { db } from "@/db/index.js";
import { ApiContext } from "@/lib/context.js";
import { logger } from "@/utils/logger.js";

/**
 * Gives every route it touches `ctx: ApiContext` (db, log, repos, services)
 * plus a request-scoped `log` carrying a fresh request id. `.as("global")`
 * so a single `.use(contextPlugin)` anywhere covers the composed app, matching
 * the starter pattern; the plugin is named, so repeated `.use()` calls are
 * deduplicated by Elysia.
 */
export const contextPlugin = new Elysia({ name: "context" })
  .use(
    elysiaLogLayer({
      instance: logger,
      requestId: () => nanoid(12),
      // HTTP request/response lines at DEBUG: they reach the server's log file
      // only while debug logging is on, and never reach the service manager's
      // log at all (spec 2026-09-12 § 3.4 — "off by default for http").
      //
      // The polled routes are ignored, or a debug session fills the 200 KB cap
      // with the Service page asking how the Service page is doing. The WS
      // paths are ignored for the same reason: every attach and every node
      // reconnect would otherwise be two lines.
      autoLogging: {
        logLevel: "debug",
        ignore: [
          "/api/admin/status",
          "/api/admin/server",
          "/api/admin/server/logs",
          "/api/setup/status",
          "/api/settings/public",
          /^\/ws(\/|$)/,
        ],
      },
    }),
  )
  .resolve(({ log }) => ({
    ctx: new ApiContext({
      db,
      log: log as unknown as LogLayer,
    }),
  }))
  .as("global");
