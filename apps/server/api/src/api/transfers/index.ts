import { Elysia } from "elysia";
import { postTransferRoute } from "./post-transfer.route.js";

/**
 * `/api/transfers` - node-to-node archive transfer (spec 2026-10-01 §5).
 * One verb in v1 (POST = start-and-finish a copy or sync, synchronously);
 * the directory exists because the resource earned the shape the moment the
 * route needed its own token scope and audit family, and a `GET /:id` row
 * view would be a resume feature (ruled OUT of v1) wearing a list costume.
 */
export const transferRoutes = new Elysia({ prefix: "/api/transfers" }).use(postTransferRoute);
