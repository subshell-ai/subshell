import { type APIRequestContext, expect, request as pwRequest, test } from "@playwright/test";
import { BASE_URL, FAKE_IDP_URL } from "../ports";
import { ADMIN_STATE } from "./helpers";

/**
 * The OIDC sign-in providers, end to end in a REAL browser (spec 2026-09-24 §4/§5/
 * §7 — the wire matrix that spec's unit twin lives in `oidc-signin-flow.test.ts`
 * drives server-side cannot prove the three things only a browser can):
 * the anonymous `providers[]` read reaching the login page as buttons, an
 * actual navigation round trip through the fake issuer (stack.ts's fourth
 * process), and the SPA's `/login?error=…` mapping — including the
 * first-arrival-generic / second-arrival-pending split the waiting room is.
 *
 * Seeding goes through the admin cookie at `POST /api/auth-providers` — the
 * same route Settings → Auth drives — because discovery is that route's SAVE
 * GATE: pointing `issuer` at the fake resolves the endpoint triple from its
 * discovery document exactly as a real IdP's would. `entryOrigins` names this
 * suite's own origin so the §5a canonical origin the callback is built on is
 * the one the browser is on.
 *
 * The admin lens is spec 01's minted state (the suite's ordering contract —
 * this file runs last); every browser context is created ANONYMOUS via
 * `browser.newContext()` so the stranger's view is never the admin's session.
 */

/** The button-label provider: kind `google`, NAME `Acme SSO` — name must win. */
const ACME = { id: "acme-sso", kind: "google", name: "Acme SSO", requireApproval: false } as const;
/** The queue provider: require-approval, so arrivals split generic/pending. */
const GATEKEEP = { id: "gatekeep", kind: "oidc", name: "Gatekeep", requireApproval: true } as const;

interface ProviderView {
  id: string;
  name: string;
  kind: string;
  requireApproval: boolean;
}

/** Admin-cookie context (seed/teardown) and a context with NO credential (the anonymous read). */
let admin: APIRequestContext;
let anon: APIRequestContext;

/** Seed one provider through the real save path; returns its view for assertions. */
async function seedProvider(provider: {
  id: string;
  kind: "google" | "oidc";
  name: string;
  requireApproval: boolean;
}): Promise<ProviderView> {
  const res = await admin.post("/api/auth-providers", {
    data: {
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      issuer: FAKE_IDP_URL,
      clientId: "e2e-oidc-client",
      clientSecret: "e2e-oidc-secret",
      entryOrigins: [BASE_URL],
      enabled: true,
      signInEnabled: true,
      // Explicit, not the create-time default (false): every flow here is a
      // NEW email, and a closed registration gate would refuse it before the
      // policy under test is ever reached.
      registrationEnabled: true,
      requireApproval: provider.requireApproval,
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as ProviderView;
}

test.beforeAll(async () => {
  admin = await pwRequest.newContext({ baseURL: BASE_URL, storageState: ADMIN_STATE });
  anon = await pwRequest.newContext({ baseURL: BASE_URL });

  const acme = await seedProvider(ACME);
  const gatekeep = await seedProvider(GATEKEEP);
  expect(acme).toMatchObject({ id: ACME.id, kind: "google", requireApproval: false });
  expect(gatekeep).toMatchObject({ id: GATEKEEP.id, kind: "oidc", requireApproval: true });

  // Leg one of the flow: the ANONYMOUS read answers both providers, in stored
  // order, with nothing but id/name/kind. (The login page's render of this
  // exact payload is test 1; asserting the wire here means a broken render
  // reads as a render bug, not a route bug.)
  const instance = await anon.get("/api/settings/instance");
  expect(instance.ok(), await instance.text()).toBe(true);
  const body = (await instance.json()) as { providers: { id: string; name: string; kind: string }[] };
  expect(body.providers).toEqual([
    { id: ACME.id, name: ACME.name, kind: "google" },
    { id: GATEKEEP.id, name: GATEKEEP.name, kind: "oidc" },
  ]);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring first argument to receive testInfo
test.afterAll(async ({}, testInfo) => {
  // Both providers leave (the E-mail provider stays open, so the last-provider guard
  // lets this through); 404 means an earlier failure already removed them.
  const cleanupFailures: string[] = [];
  for (const id of [ACME.id, GATEKEEP.id]) {
    try {
      const res = await admin.delete(`/api/auth-providers/${id}`);
      if (!(res.ok() || res.status() === 404)) {
        cleanupFailures.push(`${id}: HTTP ${res.status()} ${await res.text()}`);
      }
    } catch (err) {
      cleanupFailures.push(`${id}: ${String(err)}`);
    }
  }
  await admin.dispose();
  await anon.dispose();
  // A swallowed cleanup failure leaks the seeded providers into whatever runs
  // next on this stack, so it must surface — but not over the real reason:
  // teardown only out-reports the tests when the tests themselves passed.
  if (cleanupFailures.length > 0 && testInfo.status === testInfo.expectedStatus) {
    throw new Error(`provider cleanup failed: ${cleanupFailures.join("; ")}`);
  }
});

/**
 * The fake issuer answers `/userinfo` with whatever the last `PUT /_profile`
 * carried. The `id` is stable per email because the provider has explicit
 * endpoints and no discovery at runtime, so genericOAuth's account subject IS
 * `profile.id` (Task 7's measured quirk, documented in the fixture).
 */
async function setProfile(email: string, name: string): Promise<void> {
  const res = await fetch(`${FAKE_IDP_URL}/_profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `acct-of-${email}`, sub: `acct-of-${email}`, email, email_verified: true, name }),
  });
  if (!res.ok) throw new Error(`fake IdP profile swap failed: HTTP ${res.status}`);
}

/** A signed-out browser — the persona every flow here starts from. */
async function signInAnonymously(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await page.goto("/login");
  return { context, page };
}

test("the login page renders a configured provider's button by its NAME, not its kind", async ({ browser }) => {
  const { context, page } = await signInAnonymously(browser);
  try {
    // The button's accessible name is the provider's name (§7's label rule,
    // `signInButtonLabel`), and this provider's kind is `google` on purpose: a
    // kind-first label would render "Sign in with Google" here, and two
    // Google-kind providers would be indistinguishable.
    await expect(page.getByRole("button", { name: "Sign in with Acme SSO", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with Google", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in with Gatekeep", exact: true })).toBeVisible();
    // The E-mail provider is still open, so the form and its button keep their
    // place beside the two new ones.
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("clicking the provider round-trips the fake IdP and lands signed in", async ({ browser }) => {
  const email = `e2e-oidc-${crypto.randomUUID()}@subshell.test`;
  await setProfile(email, "E2E Acme User");

  const { context, page } = await signInAnonymously(browser);
  try {
    await page.getByRole("button", { name: "Sign in with Acme SSO", exact: true }).click();
    // A REAL navigation, followed for what it is: the client POSTs
    // /sign-in/social and leaves for the issuer's /authorize (ports.ts's
    // fakeIdp), which 302s to /api/auth/callback/acme-sso with the code and
    // the state cookie, which mints the session and 302s home. Landing back
    // on the app root IS the proof no stubbed hop faked.
    await expect(page).toHaveURL(`${BASE_URL}/`, { timeout: 30_000 });

    // "A 200 is not a session" — the check is the session itself, read with
    // the page's own cookie jar, naming the IdP-provided address.
    const session = await page.request.get("/api/auth/get-session");
    expect(session.ok(), await session.text()).toBe(true);
    expect(((await session.json()) as { user: { email: string } | null }).user?.email).toBe(email);

    // And the signed-in shell, not a stale login frame: the sidebar account
    // menu (spec 01's locator) renders behind the gate.
    await expect(page.getByRole("button", { name: /Account:/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a require-approval provider: first arrival the generic line, second arrival /pending", async ({ browser }) => {
  const email = `e2e-pending-${crypto.randomUUID()}@subshell.test`;
  await setProfile(email, "E2E Pending User");

  const { context, page } = await signInAnonymously(browser);
  try {
    // First arrival: the row is created pending and the session hook refuses
    // generically — `unable_to_create_session` carries no description, and it
    // MUST NOT be readable as the waiting room (indistinguishability, §4).
    await page.getByRole("button", { name: "Sign in with Gatekeep", exact: true }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
    await expect(page.getByText("Sign-in could not complete")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in again" })).toHaveCount(0);

    // Second arrival: the SAME identity knocking again is refused at the
    // named code with the email, and the login page moves to the waiting
    // room carrying it (§6's dedup, §7's screen).
    await page.getByRole("button", { name: "Sign in with Gatekeep", exact: true }).click();
    await expect(page).toHaveURL(/\/pending/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
