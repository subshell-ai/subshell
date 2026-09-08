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
    }),
  )
  .resolve(({ log }) => ({
    ctx: new ApiContext({
      db,
      log: log as unknown as LogLayer,
    }),
  }))
  .as("global");
