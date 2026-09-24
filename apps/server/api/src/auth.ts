import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { sql } from "kysely";
import { auditAuthAfterRequest, auditSessionDeleted } from "@/auth/audit-hooks.js";
import { authDatabase } from "@/auth/database.js";
import { createDoorGuardBeforeHook } from "@/auth/door-guards.js";
import { type DoorValidationData, evaluateDoorPolicy } from "@/auth/door-policy.js";
import { loadProviderRowsSync, toGenericOAuthConfig } from "@/auth/provider-rows.js";
import { APP_BASE_URL, AUTH_SECRET } from "@/constants.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { REAL_ACCOUNT_FILTER } from "@/db/repositories/users.repository.js";
import { FIRST_SETUP_STEP } from "@/db/types/setup-step.js";
import { accountDisabled, accountPending } from "@/services/account-status.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { normalizeUserName } from "@/services/user-name.js";
import { logger } from "@/utils/logger.js";

/**
 * The raw better-auth options, exported for `runAuthMigrations`:
 * `getMigrations` must receive the FULL options (plugins included) to create
 * plugin-owned tables like `apikey` — passing only `{ database }` silently
 * skips them.
 *
 * Deliberately carries NO `database` key: opening SQLite at module evaluation
 * was the graph's import-time IO (spec 2026-09-03 §2), so every consumer
 * supplies its own handle — `runAuthMigrations`/the migration tests pass
 * theirs in their spread, and `buildAuth` wires {@link authDatabase} on
 * first use. Roles do NOT live on the better-auth user; they live in the
 * app's `user_meta` table via the databaseHooks below.
 */
const doorGuardBeforeHook = createDoorGuardBeforeHook(() => appDb);

export const AUTH_OPTIONS = {
  baseURL: APP_BASE_URL,
  secret: AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
  },
  user: {
    // §3: the one policy seam 1.7.1 offers (measured: there is no
    // per-provider hook, and no `validateUserInfo` call anywhere on the
    // email-password SIGN-IN path — that refusal is `door-guards`'s job).
    // Rejection is a RETURNED `{ error, errorDescription }` — NOT a thrown
    // string and NOT the literal "reject" (a returned string's `.error` is
    // undefined ⇒ ALLOWED; assertValidUserInfo reads `result?.error`). The
    // codes ride out as a 403 APIError whose `code` is exactly this `error`,
    // which is how `/pending` and the login page map the refusal (§4).
    validateUserInfo: async (data: DoorValidationData, _ctx: unknown) => {
      if (!appDb) return undefined; // pre-boot: matches the other policy reads' gap behavior
      return await evaluateDoorPolicy(appDb, data);
    },
  },
  account: {
    accountLinking: {
      // Spec §5, measured: 1.7.1's implicit link gate demands the LOCAL user's
      // emailVerified by default, and every account this instance writes has
      // it FALSE — the spec's core linking requirement would die with a
      // generic "account not linked". The inversion makes the PROVIDER's
      // verified claim the link defense; that claim's enforcement (door-policy
      // + mapProfileToUser) is what pays for it, and docs/security.md §5
      // accounting lands with it (final docs task). 1.7.1 marks the member
      // deprecated ("gate becomes unconditional"); upgrading better-auth
      // therefore re-arms the default this line removes, and the upgrade is a
      // spec-§5 decision, not a dependency bump.
      requireLocalEmailVerified: false,
    },
  },
  // The FUNCTION form, which better-auth 1.7.1 re-invokes per request
  // (`dist/auth/base.mjs` getTrustedOrigins(options, request); the origin
  // middleware again inside validateOrigin) and once at its own init with NO
  // request (`dist/context/create-context.mjs`). The parameter is therefore
  // optional and deliberately unread: nothing about the caller's request may
  // widen this list — that is the DNS-rebinding rule the registry keeps.
  trustedOrigins: (_request?: Request) => [...originRegistry().current()],
  session: {
    // Deliberately short (security audit 2026-08, F5): cookieCache lets
    // better-auth answer its own session endpoints (sign-out freshness,
    // requireSession inside better-auth plugins) from a client-held cookie
    // for up to `maxAge` seconds WITHOUT a DB read — so a copied or stale
    // cookie jar kept passing those endpoints for up to 7 days after
    // sign-out. 5 minutes bounds that revocation window. App routes never
    // depended on this cache: `authGuard` feeds only the session_token to
    // `auth.api.getSession`, which is DB-backed every request, so route
    // freshness is unchanged.
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes in seconds
    },
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax" as const, // literal kept: AUTH_OPTIONS leaves the inline-literal typing context
    },
  },
  // API keys for machine access (MCP bearer tokens + admin-managed system
  // keys). Rate limiting is off: subshells long-poll channel reads and would
  // trip per-minute request ceilings for no protective benefit on a local
  // service (keys themselves are the credential boundary).
  plugins: [
    apiKey({
      enableMetadata: true,
      requireName: true,
      // Session token names are "sess:<uuid>" (41 chars); default cap is 32.
      maximumNameLength: 64,
      defaultPrefix: "subshell_",
      rateLimit: { enabled: false },
    }),
    // Passkeys (spec 2026-08-31): additional browser credential, never a
    // second factor. rpID is deliberately unset — better-auth 1.7.1 derives
    // it from the CONFIGURED baseURL (options.rpID || new URL(baseURL)
    // .hostname, passkey dist index.mjs:13), NEVER the request host. So
    // passkeys bind to the instance's canonical address (APP_BASE_URL's
    // host): browsing from any other name — loopback against a
    // domain-configured instance, or a relocated host — fails WebAuthn
    // validation in the browser before reaching the server. Pinned by the
    // rp.id assertion in passkey-plugin.test.ts; the UI copy says the same.
    // origin unset likewise: the client supplies it (1.7.1 documented default).
    passkey({ rpName: "subshell" }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (newUser: { name?: string }) => {
          // The registration gate USED to refuse here; it now refuses in
          // `user.validateUserInfo` (above), which 1.7.1 runs before this
          // hook and on every provisioning path this instance has — see
          // spec 2026-09-24 §3.
          // The display name is normalized HERE because this is the one
          // seam every sign-up shares. The first-run wizard calls
          // `signUp.email` directly, so `POST /api/users`'s own normalizer
          // never sees the very first admin's name — and that name is rendered
          // to every other user as a share grantee label and reaches log
          // lines. better-auth 1.7.1 merges a returned `{ data }` over the row
          // it was about to write (`db/with-hooks.mjs`), which is what makes a
          // rewrite possible at all; `false` still aborts, so this seam
          // remains able to refuse if a future rule needs one.
          const name = normalizeUserName(newUser.name ?? "");
          // Nothing printable becomes "" rather than a refusal: a refusal here
          // is a failed first run, and "" is the value `displayNamesByIds`
          // already reads as "no chosen name" and renders as the address.
          if (name === newUser.name) return undefined;
          return { data: { name } };
        },
        after: async (createdUser) => {
          await promoteFirstUserToAdmin(createdUser.id);
        },
      },
    },
    account: {
      create: {
        after: markApprovalDoorArrival,
      },
    },
    session: {
      create: {
        before: async (session: { userId: string }) => {
          // A disabled or pending account may not authenticate. The hook sits
          // on SESSION creation rather than on the email sign-in endpoint
          // because every credential kind mints a session here — password and
          // passkey alike — so one refusal covers both, and whatever is added
          // next. Pending lands here for the first-arrival OAuth sign-in and
          // stays the backstop behind `validateUserInfo` (§4).
          if (await signInAllowed(session.userId)) return undefined;
          return false;
        },
      },
      delete: {
        after: async (session: { userId: string }) => {
          // `auth.sign_out` (audit item R1): one row per session row ACTUALLY
          // deleted. The delete hook is the seam rather than `hooks.after` on
          // `/sign-out` because that endpoint answers `{ success: true }`
          // even when nobody was signed in, and its hook context names no
          // user — here the row is the proof and `userId` the actor.
          await auditSessionDeleted(session);
        },
      },
    },
  },
  // `auth.sign_in` (audit item R1): successful sign-ins, keyed by endpoint
  // path inside the handler — see `@/auth/audit-hooks` for what counts as
  // success and why failures deliberately write nothing. Runs for every
  // better-auth request, so the path table short-circuits everything else.
  hooks: {
    // The closed E-mail door's sign-in refusal (spec §7) — see
    // `@/auth/door-guards` for why THIS layer and not `validateUserInfo`
    // carries it (measured: that hook never fires on the sign-in paths).
    before: doorGuardBeforeHook,
    after: auditAuthAfterRequest,
  },
};

/**
 * Builds the better-auth instance. Its constructor OPENS SQLite, and so does
 * {@link authDatabase} — both therefore live HERE, never in the
 * module-evaluation path of `AUTH_OPTIONS` (import-purity invariant, spec
 * 2026-09-03 §2: the entry graph must stay IO-free for the `mcp`
 * subcommand's lifetime; pinned by auth-import-purity.test.ts). The auth
 * database is the same bun:sqlite file as the app (better-auth's bundled
 * dialect handles it).
 *
 * `genericOAuth` joins the plugin list HERE and not in `AUTH_OPTIONS`:
 * AUTH_OPTIONS also feeds `runAuthMigrations`, which receives the FULL
 * options — a door row that made plugin init throw (a bad config, a discovery
 * fallback) would then crash-loop BOOT, since migrations run before anything
 * listens (spec §3). genericOAuth registers no tables of its own, so the
 * migration path never needs it, and a broken door costs the auth instance
 * only — which {@link getAuth}'s last-known-good rule then papers over.
 * The email row is a door for POLICY purposes (§2) and never an OAuth one:
 * it is filtered here, before the config array is built.
 */
function buildAuth() {
  const doors = loadProviderRowsSync().filter((r) => r.kind !== "email");
  const config = doors.map((r) => toGenericOAuthConfig(r, r.entryOrigins[0] ?? APP_BASE_URL)); // canonical = list position 0 (§5a)
  return betterAuth({
    ...AUTH_OPTIONS,
    database: authDatabase(),
    plugins: config.length > 0 ? [...AUTH_OPTIONS.plugins, genericOAuth({ config })] : AUTH_OPTIONS.plugins,
  });
}

type Auth = ReturnType<typeof buildAuth>;
let instance: Auth | undefined;
/** The last instance that built cleanly, for the fallback below. */
let lastGood: Auth | undefined;

/**
 * The better-auth instance (singleton per the code-style rule), built on
 * FIRST USE. Everything that needs auth does so at boot or per-request —
 * both well after module evaluation — so the laziness is invisible in
 * behavior and visible only in the absence of import-time side effects.
 *
 * A rebuild that THROWS serves the last known-good configuration rather than
 * taking the instance down: an admin saving a junk provider row must not
 * sign every existing user out mid-edit (spec §3). The first-ever build
 * failing still throws — there is no known-good to serve, and a silent
 * stand-in would be a fake.
 */
export function getAuth(): Auth {
  if (instance) return instance;
  try {
    instance = buildAuth();
    lastGood = instance;
  } catch (err) {
    logger.withError(err).error("building the auth instance failed; serving the last known-good configuration");
    if (!lastGood) throw err; // first build can still fail loudly
    instance = lastGood;
  }
  return instance;
}

/**
 * Drops the memoized instance so the next {@link getAuth} rebuilds from the
 * CURRENT `auth_providers` table (spec §3). Called by the provider route
 * after every successful write — no process restart; same sibling semantics
 * as {@link resetAuthForTests}, which stays @internal and unchanged.
 */
export function invalidateAuth(): void {
  instance = undefined;
}

/**
 * Drops the memoized instance. Only for tests that need a fresh build.
 * @internal
 */
export function resetAuthForTests(): void {
  instance = undefined;
}

let appDb: import("kysely").Kysely<import("@/db/types/index.js").Database> | undefined;

/** Injected by the app bootstrap so auth policy can read app settings. */
export function setAuthPolicyDb(db: import("kysely").Kysely<import("@/db/types/index.js").Database>): void {
  appDb = db;
}

/**
 * Whether this user may be given a session at all.
 *
 * Delegates to `services/account-status.ts`, which `authGuard` reads through
 * as well — this hook closes the door on new sessions, the guard closes it on
 * credentials already issued, and a second reading of the row is how the two
 * come to disagree.
 *
 * PENDING joins DISABLED here (spec 2026-09-24 §4): the first-arrival session
 * refusal for an approval-gated OIDC account, and the backstop behind
 * `validateUserInfo`. Disabled is asked FIRST and it wins: a pending account
 * that an admin also disabled is refused for the stronger reason, and neither
 * answer may leak the other's truth — the user-visible code for this whole
 * path is better-auth's generic `unable_to_create_session`, deliberately: it
 * cannot distinguish pending from disabled and neither leaks the other's.
 *
 * `!appDb` is before the database is wired, which is only ever during boot;
 * allowing there matches what the registration gate does with the same gap.
 */
async function signInAllowed(userId: string): Promise<boolean> {
  if (!appDb) return true;
  return !(await accountDisabled(appDb, userId)) && !(await accountPending(appDb, userId));
}

/**
 * `databaseHooks.account.create.after` — exported for the hook test; wired
 * verbatim into {@link AUTH_OPTIONS}.
 *
 * The ONLY seam that sees the provider at creation time (user.create.after
 * fires before the account row exists — measured, review finding 5). Marks
 * require-approval doors' ARRIVALS pending and undoes the first-admin
 * promotion that `user.create.after` just wrote for them (§6): an OIDC-arrival
 * creator can never end up admin, on an instance with no admin yet or one
 * with an existing admin miscounted as none. The `credential` skip is the
 * email door (its account rows spell their provider that way — measured,
 * `dist/api/routes/sign-up.mjs`); the `getById` miss covers every other
 * non-door providerId (a passkey row says "passkey").
 *
 * ARRIVALS ONLY, decided by account count: `linkAccount` runs through the
 * same adapter create (`db/internal-adapter.mjs` — measured), so an approved
 * EXISTING user linking an approval door would otherwise be marked pending
 * and, if they were the sole admin, DEMOTED by the clause below — the
 * instance losing its last admin to a link. The pure cascade already answers
 * links (approved links pass; pending/rejected refuse), so marking here would
 * contradict §5's policy with §6's queue, and the demote's "only the row the
 * promotion just wrote" claim holds precisely because a fresh arrival is a
 * user with exactly one account.
 */
export async function markApprovalDoorArrival(account: {
  id: string;
  providerId: string;
  userId: string;
}): Promise<void> {
  if (account.providerId === "credential" || !appDb) return;
  const door = await new AuthProvidersRepository(appDb).getById(account.providerId);
  if (door === undefined || door.requireApproval !== 1) return;
  // Raw SQL: better-auth's `account` table, physical camelCase names.
  const others = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM account WHERE userId = ${account.userId} AND id <> ${account.id}
  `.execute(appDb);
  if (Number(others.rows[0]?.n ?? 0) > 0) return; // a link, not an arrival
  const meta = new UserMetaRepository(appDb);
  await meta.setApproval(account.userId, "pending", { arrivedAt: new Date().toISOString() });
  await meta.demoteAdminIfAutoPromoted(account.userId);
}

/**
 * The first user ever registered becomes admin; everyone else lands on
 * "user". Roles live in `user_meta` (separate from the auth user table).
 *
 * **First-user-ness is decided from ACCOUNTS** (security-actionable 2026-09
 * item 9), the same notion the registration gate counts
 * (`registration-gate.ts` → `countRealAccounts`): the probe's second clause
 * shares that gate's `REAL_ACCOUNT_FILTER`, so the two surfaces cannot
 * disagree about "has anybody registered". It used to ask only whether
 * `user_meta` was empty, and `user_meta` is this statement's own output —
 * an instance whose only human never got a meta row (the hook not reached)
 * read as nobody having registered, and minted the next account admin.
 *
 * ONE atomic statement (security audit 2026-08, F6b): the old count-then-
 * insert let two concurrent first sign-ups both read zero and both mint
 * admin, and its `onConflict doUpdateSet({ role })` could afterwards flip a
 * winner back to loser. Both clauses of the probe live inside the INSERT
 * (`CASE WHEN NOT EXISTS (…)`), which SQLite evaluates under the write
 * lock, and each covers the other's blind spot:
 *
 * - *no other admin meta row* is the self-referential half that makes the
 *   concurrency proof exact — the second concurrent caller necessarily sees
 *   the winner's freshly-written admin row, whatever their `createdAt`
 *   values say (same-millisecond sign-ups included, and the hook runs
 *   AFTER this account's `user` row exists, so "strictly older" alone could
 *   never rank two accounts created in one breath);
 * - *no strictly-older real account* is what an orphaned meta-less user row
 *   still testifies to. It is strict-`<` on purpose: an account whose row
 *   is missing (the scratch concurrency test, or a hook racing its own row)
 *   sees no older row, and the first clause alone then decides, which is
 *   exactly F6b's documented semantics.
 *
 * The `system` service row boot writes (`index.ts` → `ensureSystemUser`) is
 * excluded by the shared filter — counting it would deny the FIRST HUMAN the
 * admin role and brick a fresh install behind a dashboard nobody can
 * administer. Documented loser semantics: it gets its own row with role
 * 'user'; re-running for an existing user is a no-op (`ON CONFLICT DO
 * NOTHING`), so a role is never overwritten here.
 *
 * **It also writes the wizard's resume bookmark** (spec 2026-09-16): the same
 * CASE decides `setup_step`, so the account that becomes admin is bookmarked
 * on the wizard's Network step and every later account on nothing. It rides
 * this statement rather than a follow-up call because the wizard's FIRST
 * screen is what creates the account — from that moment the server reports
 * setup as done — so a bookmark written any later loses the place of anyone
 * who closes the app in between.
 *
 * Exported for the concurrency test, which runs it against a private
 * scratch database (the shared test DB can never be observed empty).
 *
 * @param db - the app database to promote within
 * @param userId - the newly created user's id
 */
export async function promoteFirstUserAtomically(
  db: import("kysely").Kysely<import("@/db/types/index.js").Database>,
  userId: string,
): Promise<void> {
  // Raw SQL on purpose: physical snake_case names, and both probes must sit
  // inside the INSERT statement (a builder `.select()` subquery for this
  // shape only re-introduces noise). CamelCasePlugin leaves snake_case text
  // untouched; the quoted camelCase `"createdAt"` is better-auth's own
  // spelling on its `user` table. The probe is spelled twice because the
  // two CASEs must be THE same condition — one admin decides both columns.
  await sql`
    INSERT INTO user_meta (user_id, role, setup_step)
    SELECT ${userId},
           CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta WHERE role = 'admin' AND user_id <> ${userId})
                  AND NOT EXISTS (SELECT 1 FROM user
                                  WHERE ${REAL_ACCOUNT_FILTER}
                                    AND id <> ${userId}
                                    AND "createdAt" < (SELECT "createdAt" FROM user WHERE id = ${userId}))
                THEN 'admin' ELSE 'user' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta WHERE role = 'admin' AND user_id <> ${userId})
                  AND NOT EXISTS (SELECT 1 FROM user
                                  WHERE ${REAL_ACCOUNT_FILTER}
                                    AND id <> ${userId}
                                    AND "createdAt" < (SELECT "createdAt" FROM user WHERE id = ${userId}))
                THEN ${FIRST_SETUP_STEP} ELSE NULL END
    ON CONFLICT (user_id) DO NOTHING
  `.execute(db);
}

/** The `databaseHooks` entry point: promote on the injected app database. */
async function promoteFirstUserToAdmin(userId: string): Promise<void> {
  if (!appDb) return;
  await promoteFirstUserAtomically(appDb, userId);
}
