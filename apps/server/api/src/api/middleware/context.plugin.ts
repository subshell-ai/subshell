import { elysiaLogLayer } from "@loglayer/elysia";
import { Elysia } from "elysia";
import type { LogLayer } from "loglayer";
import { nanoid } from "nanoid";
import { ApiContext } from "@/app/context.js";
import { db } from "@/db/index.js";
import { logger } from "@/shared/logger.js";

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
  /^\/api\/subshells\/(?:[^/]+\/)?subagents(?:\/report)?$/,
  "/api/admin/status",
  "/api/admin/server",
  "/api/admin/server/logs",
  "/api/setup/status",
  "/api/settings/public",
  // A node's log, polled once a second by whoever has that node's page open.
  // A regex because the id is in the path.
  /^\/api\/nodes\/[^/]+\/logs$/,
  // The preview poll an open pane view runs (spec §7): the exact path, so
  // the open/watch acts under it keep their request lines.
  /^\/api\/subshells\/[^/]+\/views$/,
  // The /pv proxy: request lines carry the path, the path carries the
  // 32-hex session ref, and the ref IS the credential (spec 2026-10-21
  // §10). A debug request line here would log a live link into someone's
  // pane port. Same class as the setup-key rule in the API AGENTS.md log
  // notes: paths that wear secrets never ride the log.
  /^\/pv\//,
  /^\/ws(\/|$)/,
  // Minted once per live-feed connect, and the feed RETRIES on a bounded
  // backoff (spec 2026-09-19 § 5) — so a tab whose session has gone while the
  // SPA still holds a cached user POSTs a 401 here every few seconds for as
  // long as it is open. That is the shape this list exists for.
  "/api/auth/ws-token",
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
