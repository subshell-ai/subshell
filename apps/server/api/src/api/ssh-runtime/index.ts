import { Elysia } from "elysia";
import { sshRuntimeNodeVerbRoutes } from "@/api/ssh-runtime/node-verbs.route.js";
import { sshRuntimeSessionsRoutes } from "@/api/ssh-runtime/sessions.route.js";

/**
 * `/api/ssh-runtime` - the Connect-over-SSH REST family (design 2026-10-05
 * §1/§7): the node-scoped pre-session reads (discovery, resolve) and the
 * session verbs. Composition only: one file per resource, the shapes and the
 * refusal mapping live beside the handlers. `routes.ts` folds this basket into
 * the machine-side group (the TS2589 rule the ssh basket's comment records: a
 * new sub-aggregate joins an existing group with headroom, never the root's
 * fullest chain).
 */
export const sshRuntimeRoutes = new Elysia({ prefix: "/api/ssh-runtime" })
  .use(sshRuntimeNodeVerbRoutes)
  .use(sshRuntimeSessionsRoutes);
