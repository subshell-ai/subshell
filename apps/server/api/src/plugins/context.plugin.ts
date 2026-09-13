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
/**
 * Paths whose request lines are NEVER written, even with debug logging on.
 *
 * Every one of these is POLLED by a page somebody leaves open, and the log
 * they would fill is one 200 KB file that REPLACES itself when full — so
 * without this, turning debug logging on destroys the history it was turned
 * on to read. The Service page asking how the Service page is doing, at one
 * second, is roughly 60 lines a minute per tab.
 *
 * The WS paths are here for the same reason: every attach and every node
 * reconnect would otherwise be two lines.
 *
 * Exported, and pinned by test, because the failure is SILENT — nothing about
 * a flooded log says which poll flooded it, and the poll that does it is
 * usually one somebody just made faster in a different package.
 */
export const REQUEST_LOG_IGNORE: (string | RegExp)[] = [
  "/api/admin/status",
  "/api/admin/server",
  "/api/admin/server/logs",
  "/api/setup/status",
  "/api/settings/public",
  // A node's log, polled once a second by whoever has that node's page open.
  // A regex because the id is in the path.
  /^\/api\/nodes\/[^/]+\/logs$/,
  /^\/ws(\/|$)/,
];

export const contextPlugin = new Elysia({ name: "context" })
  .use(
    elysiaLogLayer({
      instance: logger,
      requestId: () => nanoid(12),
      // HTTP request/response lines at DEBUG: they reach the server's log file
      // only while debug logging is on, and never reach the service manager's
      // log at all (spec 2026-09-12 § 3.4 — "off by default for http").
      //
      autoLogging: {
        logLevel: "debug",
        ignore: REQUEST_LOG_IGNORE,
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
