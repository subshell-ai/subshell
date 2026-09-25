import { hashPassword } from "better-auth/crypto";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { assertPasswordLength } from "@/api/users/assert-password-length.js";
import { UsersError } from "@/api/users/users-error.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { DEFAULT_USER_ROLE, USER_ROLES } from "@/db/types/user-role.js";
import { audit } from "@/services/audit.js";
import { checkUserName, USER_NAME_MAX } from "@/services/user-name.js";

const CreateUserBodySchema = t.Object({
  name: t.String({
    description:
      "Display name for the new account. Control characters are stripped, whitespace collapsed, and the result must be 1-64 characters. Enforced in the handler rather than by schema bounds, which would both accept a run of spaces and echo a rejected value back (see MIN_PASSWORD_LENGTH)",
  }),
  email: t.String({ description: "Email address for the new credential account" }),
  password: t.String({
    description:
      "Initial password, at least 8 characters. Checked in the handler, not by the schema, so a rejection cannot echo it back (see MIN_PASSWORD_LENGTH)",
  }),
  role: t.Union(
    USER_ROLES.map((role) => t.Literal(role)),
    { default: DEFAULT_USER_ROLE, description: "App role for the new user" },
  ),
});

const CreateUserResponseSchema = t.Object({
  id: t.String({ description: "New user id" }),
  email: t.String({ description: "New user email" }),
  name: t.String({ description: "Display name" }),
  role: t.String({ description: "Assigned role" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
});

/**
 * Cleans the submitted display name and refuses an empty or over-long result
 * WITHOUT naming it.
 *
 * In the handler for the same reason the password bound is: schema
 * `minLength`/`maxLength` would both accept `"   "` and, on a failure, put the
 * offending value in the message `error-handler.plugin.ts` copies into the
 * response body. The name is not the admin's private label — it is rendered
 * to everyone a subshell is shared with and it reaches log lines — so it goes
 * through the same normalizer node names and the instance name do; the rule
 * itself lives in `services/user-name.ts`, which the sign-up hook shares.
 */
function requireName(name: string): string {
  const result = checkUserName(name);
  if (result.ok) return result.name;
  if (result.reason === "too_long") {
    throw new UsersError("bad_request", `Name must be at most ${USER_NAME_MAX} characters.`, 400);
  }
  // Copy unchanged from when this only trimmed: a name made entirely of
  // control characters is still an admin who has not supplied one.
  throw new UsersError("bad_request", "Name is required.", 400);
}

/**
 * `POST /api/users` — creates a credential user with a role (admin only,
 * cookie session; the requireAdmin derive answers 401 anonymous and
 * 403 bearer-or-non-admin).
 */
export const createUserRoute = new Elysia().use(requireAdmin).post(
  "/",
  async ({ body, user }) => {
    const name = requireName(body.name);
    assertPasswordLength(body.password);
    const repo = new UsersRepository(db);
    const email = body.email.trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);
    let id: string;
    try {
      id = await repo.createUser({ name, email, passwordHash, role: body.role });
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE") && err.message.includes("user.email")) {
        // Spec §5 keeps this answer GENERIC for every holder, OIDC included:
        // an admin typing an email that exists does not need a provider name
        // back (they already see every email per §3 of the security rules,
        // so the name discloses nothing AND remedies nothing they cannot see
        // in the roster). The named refusal belongs to the public sign-up
        // provider alone — `@/auth/held-email-guards`, where the person asking
        // genuinely cannot see who holds their address.
        throw new UsersError("conflict", "E-mail already registered");
      }
      throw err;
    }
    // Audit the admin action; best-effort (never breaks the create).
    await audit({
      actorUserId: user.id,
      action: "user.create",
      targetType: "user",
      targetId: id,
      metadataJson: JSON.stringify({ email }),
    });
    return { id, email, name, role: body.role, createdAt: new Date().toISOString() } as const;
  },
  {
    body: CreateUserBodySchema,
    response: CreateUserResponseSchema,
    detail: {
      operationId: "createUser",
      tags: ["users"],
      description: "Creates a credential user with a role (admin only, cookie session)",
    },
  },
);
