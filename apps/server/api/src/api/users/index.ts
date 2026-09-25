import { Elysia } from "elysia";
import { createUserRoute } from "@/api/users/create-user.route.js";
import { listPendingApprovalsRoute } from "@/api/users/list-pending.route.js";
import { listUsersRoute } from "@/api/users/list-users.route.js";
import { resetUserPasswordRoute } from "@/api/users/reset-user-password.route.js";
import { setUserApprovalRoute } from "@/api/users/set-user-approval.route.js";
import { setUserDisabledRoute } from "@/api/users/set-user-disabled.route.js";
import { setUserRoleRoute } from "@/api/users/set-user-role.route.js";

/**
 * `/api/users` — one Elysia instance per endpoint (the `api/channels/`
 * convention), mounted in the original monolithic route's order.
 *
 * The instance-wide read-only roster is `listUsersRoute` (any authenticated
 * viewer, cookie or bearer); management (create, role, password, disable, the
 * approval queue) is admin-cookie-only, so each management module composes
 * `requireAdmin` itself — 401 anonymous, 403 bearer-or-non-admin, exactly as
 * the shared derive spells it.
 */
export const usersRoutes = new Elysia({ prefix: "/api/users" })
  .use(listUsersRoute)
  .use(createUserRoute)
  .use(setUserRoleRoute)
  .use(resetUserPasswordRoute)
  .use(setUserDisabledRoute)
  .use(listPendingApprovalsRoute)
  .use(setUserApprovalRoute);
