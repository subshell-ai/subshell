import { Elysia } from "elysia";
import { sshRuntimeSessionsRoutes } from "@/api/ssh-runtime/sessions.route.js";

/**
 * `/api/ssh-runtime` - the Gate A slice's REST family (design 2026-10-05 §9),
 * composition only: one file per resource, the shapes and the refusal mapping
 * live beside the handlers. `routes.ts` folds this basket into the machine-side
 * group (the TS2589 rule the ssh basket's comment records: a new sub-aggregate
 * joins an existing group with headroom, never the root's fullest chain).
 */
export const sshRuntimeRoutes = new Elysia({ prefix: "/api/ssh-runtime" }).use(sshRuntimeSessionsRoutes);
