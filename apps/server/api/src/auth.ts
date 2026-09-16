import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { sql } from "kysely";
import { authDatabase } from "@/auth/database.js";
import { APP_BASE_URL, AUTH_SECRET, TRUSTED_ORIGINS } from "@/constants.js";
import { FIRST_SETUP_STEP } from "@/db/types/setup-step.js";
import { accountDisabled } from "@/services/account-status.js";
import { registrationOpen } from "@/services/registration-gate.js";
import { normalizeUserName } from "@/services/user-name.js";

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
export const AUTH_OPTIONS = {
  baseURL: APP_BASE_URL,
  secret: AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: TRUSTED_ORIGINS,
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
          // Registration gate: once the app is set up, the admin can close it.
          if (!(await registrationAllowed())) {
            return false;
          }
          // ...and the display name is normalized HERE because this is the one
          // seam every sign-up shares. The first-run wizard calls
          // `signUp.email` directly, so `POST /api/users`'s own normalizer
          // never sees the very first admin's name — and that name is rendered
          // to every other user as a share grantee label and reaches log
          // lines. better-auth 1.7.1 merges a returned `{ data }` over the row
          // it was about to write (`db/with-hooks.mjs`), which is what makes a
          // rewrite possible at all; `false` still aborts, so the gate above
          // is unaffected.
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
    session: {
      create: {
        before: async (session: { userId: string }) => {
          // A disabled account may not authenticate. The hook sits on SESSION
          // creation rather than on the email sign-in endpoint because every
          // credential kind mints a session here — password and passkey
          // alike — so one refusal covers both, and whatever is added next.
          if (await signInAllowed(session.userId)) return undefined;
          return false;
        },
      },
    },
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
 */
function buildAuth() {
  return betterAuth({ ...AUTH_OPTIONS, database: authDatabase() });
}

type Auth = ReturnType<typeof buildAuth>;
let instance: Auth | undefined;

/**
 * The better-auth instance (singleton per the code-style rule), built on
 * FIRST USE. Everything that needs auth does so at boot or per-request —
 * both well after module evaluation — so the laziness is invisible in
 * behavior and visible only in the absence of import-time side effects.
 */
export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
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
 * Reads the registration gate.
 *
 * Delegates to `services/registration-gate.ts`, which the settings routes
 * read through as well — three surfaces decide things from this answer (this
 * hook refuses the POST, the admin switch draws itself, the sign-in page
 * offers or hides "create an account"), and a second reading of the row is
 * how they come to disagree.
 *
 * `!appDb` is before the database is wired, which is only ever during boot;
 * open there matches the pre-setup window the shared function describes.
 */
async function registrationAllowed(): Promise<boolean> {
  if (!appDb) return true;
  return await registrationOpen(appDb);
}

/**
 * Whether this user may be given a session at all.
 *
 * Delegates to `services/account-status.ts`, which `authGuard` reads through
 * as well — this hook closes the door on new sessions, the guard closes it on
 * credentials already issued, and a second reading of the row is how the two
 * come to disagree.
 *
 * `!appDb` is before the database is wired, which is only ever during boot;
 * allowing there matches what the registration gate does with the same gap.
 */
async function signInAllowed(userId: string): Promise<boolean> {
  if (!appDb) return true;
  return !(await accountDisabled(appDb, userId));
}

/**
 * The first user ever registered becomes admin; everyone else lands on
 * "user". Roles live in `user_meta` (separate from the auth user table).
 *
 * ONE atomic statement (security audit 2026-08, F6b): the old count-then-
 * insert let two concurrent first sign-ups both read zero and both mint
 * admin, and its `onConflict doUpdateSet({ role })` could afterwards flip a
 * winner back to loser. Here the emptiness test lives inside the INSERT
 * itself (`CASE WHEN NOT EXISTS (…)`), which SQLite evaluates under the
 * write lock — the second concurrent caller necessarily sees the winner's
 * row and lands on 'user'. Documented loser semantics: it gets its own row
 * with role 'user'; re-running for an existing user is a no-op
 * (`ON CONFLICT DO NOTHING`), so a role is never overwritten here.
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
  // Raw SQL on purpose: physical snake_case names, and the emptiness probe
  // must sit inside the INSERT statement (a builder `.select()` subquery for
  // this shape only re-introduces noise). CamelCasePlugin leaves snake_case
  // text untouched.
  await sql`
    INSERT INTO user_meta (user_id, role, setup_step)
    SELECT ${userId},
           CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta) THEN 'admin' ELSE 'user' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta) THEN ${FIRST_SETUP_STEP} ELSE NULL END
    ON CONFLICT (user_id) DO NOTHING
  `.execute(db);
}

/** The `databaseHooks` entry point: promote on the injected app database. */
async function promoteFirstUserToAdmin(userId: string): Promise<void> {
  if (!appDb) return;
  await promoteFirstUserAtomically(appDb, userId);
}
