import { Elysia } from "elysia";
import { ServerUpdateViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { collectServerUpdateView } from "@/services/server-update.js";

/**
 * `GET /api/admin/server/update` — whether this server can replace itself, and
 * with what (spec 2026-09-15 §4.5).
 *
 * It NEVER forces a network read: the release index carries a 15-minute TTL and
 * this route trusts it, because the page polls this at 1 s while a job runs and
 * a poll that fetched the release list would spend a rate limit on a progress
 * bar. The Re-check button is the other route, and it is the only thing that
 * busts the memo.
 *
 * `requireAdmin` for the reason every route in this directory has it: the body
 * names the installed binary's path, the backups directory and the release
 * source, and bearer keys are refused so a system or subshell key cannot read
 * the instance's shape — let alone press the button next to it.
 */
export const getUpdateRoute = new Elysia().use(requireAdmin).get("/update", () => collectServerUpdateView(), {
  response: ServerUpdateViewSchema,
  detail: {
    operationId: "getServerUpdate",
    tags: ["admin"],
    description:
      "Whether a newer server release exists, whether this host could apply it, which binary would be replaced, and the state of any running update. Reads the cached release index; never forces a network read. Cookie-admin only; bearer keys are refused.",
  },
});
