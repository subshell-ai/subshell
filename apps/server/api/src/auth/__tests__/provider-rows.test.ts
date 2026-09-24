import { beforeAll, describe, expect, test } from "bun:test";
import type { GenericOAuthUserInfo } from "better-auth/plugins";
import {
  loadProviderRowsSync,
  pickEntryOrigin,
  type StoredProviderRow,
  toGenericOAuthConfig,
} from "@/auth/provider-rows.js";
import { DATABASE_PATH } from "@/constants.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";

const row = (over: Partial<StoredProviderRow>): StoredProviderRow => ({
  id: "acme",
  kind: "oidc",
  name: "Acme",
  issuer: "https://id.acme",
  clientId: "cid",
  clientSecret: "sec",
  endpoints: {
    authorizationUrl: "https://id.acme/authorize",
    tokenUrl: "https://id.acme/token",
    userInfoUrl: "https://id.acme/userinfo",
  },
  entryOrigins: ["https://sub.acme", "http://127.0.0.1:3080"],
  allowedDomains: [],
  signInEnabled: true,
  registrationEnabled: true,
  requireApproval: false,
  ...over,
});

describe("toGenericOAuthConfig", () => {
  test("explicit endpoints + accountIssuer are carried; discovery is never re-fetched", () => {
    const cfg = toGenericOAuthConfig(row({}), "https://sub.acme");
    expect(cfg).toMatchObject({
      providerId: "acme",
      name: "Acme",
      clientId: "cid",
      clientSecret: "sec",
      accountIssuer: "https://id.acme",
      authorizationUrl: "https://id.acme/authorize",
      tokenUrl: "https://id.acme/token",
      userInfoUrl: "https://id.acme/userinfo",
      redirectURI: "https://sub.acme/api/auth/callback/acme",
      scopes: ["openid", "email", "profile"],
    });
    // The belt-and-suspenders half of §3: a config that could fall back to
    // discovery would carry a discoveryUrl, and a dead issuer would then throw
    // at build. There is none.
    expect(cfg.discoveryUrl).toBeUndefined();
    // And no config-level sign-up gate either (Task 7 finding, §4):
    // genericOAuth's `disableSignUp` short-circuits the create path with the
    // generic `signup_disabled` BEFORE `user.validateUserInfo` runs, which
    // would swap the spec's named `registration_closed` for a code the login
    // page does not map. The door policy is the ONE registration seam.
    expect(cfg.disableSignUp).toBeUndefined();
  });

  test("registrationEnabled false/NULL both leave the config gate unset — the hook decides (§4)", () => {
    // The refusal itself is the door policy's, and it is pinned where it lives
    // (`door-policy.test.ts`); what this file pins is that the BUILD does not
    // shadow that seam whatever the stored registration decision says.
    expect(toGenericOAuthConfig(row({ registrationEnabled: false }), "https://sub.acme").disableSignUp).toBeUndefined();
    expect(toGenericOAuthConfig(row({ registrationEnabled: null }), "https://sub.acme").disableSignUp).toBeUndefined();
  });

  test("mapProfileToUser takes emailVerified ONLY from the verified claim (§5)", () => {
    // A real OIDC userinfo profile carries `email_verified` and lacks the
    // optimistic `emailVerified` the callback's parameter type demands — the
    // cast names that: this is raw provider data, which is exactly what §5
    // must survive.
    const rawProfile = (p: Record<string, unknown>) => p as GenericOAuthUserInfo;
    const cfg = toGenericOAuthConfig(row({}), "https://sub.acme");
    expect(cfg.mapProfileToUser?.(rawProfile({ email: "a@b.c", email_verified: true, name: "A" }))).toMatchObject({
      email: "a@b.c",
      emailVerified: true,
      name: "A",
    });
    expect(cfg.mapProfileToUser?.(rawProfile({ email: "a@b.c", name: "A" }))).toMatchObject({ emailVerified: false });
    // A truthy-but-not-true claim is not the claim: only the literal true verifies.
    expect(cfg.mapProfileToUser?.(rawProfile({ email: "a@b.c", email_verified: "true" }))).toMatchObject({
      emailVerified: false,
    });
  });

  test("redirect URI is exactly the caller's canonical origin plus the callback path", () => {
    // The per-request follow-the-visitor choice is applied by the caller
    // picking canonicalOrigin; assert ONLY that the redirect URI is exactly
    // origin+path.
    const cfg = toGenericOAuthConfig(row({ entryOrigins: ["https://x.example"] }), "https://mesh.ts.internal");
    expect(cfg.redirectURI).toBe("https://mesh.ts.internal/api/auth/callback/acme");
  });
});

describe("pickEntryOrigin (§5a)", () => {
  test("exact membership of the stored list wins; anything else falls back", () => {
    const origins = ["https://sub.acme", "http://127.0.0.1:3080"];
    expect(pickEntryOrigin(origins, "http://127.0.0.1:3080", "https://sub.acme")).toBe("http://127.0.0.1:3080");
    expect(pickEntryOrigin(origins, "https://evil.example", "https://sub.acme")).toBe("https://sub.acme");
    expect(pickEntryOrigin(origins, "https://sub.acme.evil.example", "https://sub.acme")).toBe("https://sub.acme");
    expect(pickEntryOrigin(origins, null, "https://sub.acme")).toBe("https://sub.acme");
    expect(pickEntryOrigin([], "http://127.0.0.1:3080", "https://sub.acme")).toBe("https://sub.acme");
  });
});

// The loader against the real per-process temp DB (bunfig preload): write a
// row through the repository, read it back through the SYNC path the auth
// build takes, and watch the three coercions it owns — 0/1 to booleans, JSON
// columns parsed, and junk JSON costing the one row rather than a throw.
describe("loadProviderRowsSync (shared temp DB)", () => {
  const repo = new AuthProvidersRepository(db);
  beforeAll(async () => {
    await runMigrations();
  });

  test("coerces booleans, parses JSON columns, skips junk-JSON rows with a warn, never throws", async () => {
    const id = `sync-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await repo.create({
        id,
        kind: "oidc",
        name: "Sync",
        issuer: "https://id.sync",
        clientId: "cid",
        clientSecret: "sec",
        endpointsJson: JSON.stringify({
          authorizationUrl: "https://id.sync/a",
          tokenUrl: "https://id.sync/t",
          userInfoUrl: null,
        }),
        entryOrigins: JSON.stringify(["https://one.sync", "https://two.sync"]),
        allowedDomains: " one.sync , two.sync ",
        signInEnabled: 1,
        registrationEnabled: 0,
        requireApproval: 1,
      });
      expect(loadProviderRowsSync(DATABASE_PATH).find((r) => r.id === id)).toEqual({
        id,
        kind: "oidc",
        name: "Sync",
        issuer: "https://id.sync",
        clientId: "cid",
        clientSecret: "sec",
        endpoints: { authorizationUrl: "https://id.sync/a", tokenUrl: "https://id.sync/t", userInfoUrl: null },
        entryOrigins: ["https://one.sync", "https://two.sync"],
        allowedDomains: ["one.sync", "two.sync"],
        signInEnabled: true,
        registrationEnabled: false,
        requireApproval: true,
      });

      // Junk JSON: the row is SKIPPED (warn logged), not thrown past and not
      // served with a junk array that would poison the redirect-URI choice.
      await repo.update(id, { entryOrigins: "{not json" });
      expect(loadProviderRowsSync(DATABASE_PATH).find((r) => r.id === id)).toBeUndefined();

      // Disabled: absent from the loader entirely — the same filter the auth
      // build reads, so a disabled door has neither a plugin config nor a row.
      await repo.update(id, { enabled: 0, entryOrigins: "[]" });
      expect(loadProviderRowsSync(DATABASE_PATH).find((r) => r.id === id)).toBeUndefined();
    } finally {
      await repo.remove(id);
    }
  });

  test("the email row is served (the door policy reads rows through this same loader)", () => {
    const email = loadProviderRowsSync(DATABASE_PATH).find((r) => r.id === "email");
    expect(email?.kind).toBe("email");
    expect(email?.signInEnabled).toBe(true);
    // NULL (legacy dynamic) or an explicit 0/1 — both are legal on this row (§2);
    // the loader preserves the difference rather than collapsing it.
    expect(email?.registrationEnabled === null || typeof email?.registrationEnabled === "boolean").toBe(true);
  });

  test("ordering follows position, then id", async () => {
    // Two rows on one position tie-break on id; a higher position sorts after.
    const base = `ord-${crypto.randomUUID().slice(0, 8)}`;
    const later = `${base}-z`;
    const earlier = `${base}-a`;
    try {
      await repo.create({ id: later, kind: "oidc", name: "Later", position: 1 });
      await repo.create({ id: earlier, kind: "oidc", name: "Earlier", position: 1 });
      const ids = loadProviderRowsSync(DATABASE_PATH)
        .filter((r) => r.id.startsWith(base))
        .map((r) => r.id);
      expect(ids).toEqual([earlier, later]);
    } finally {
      await repo.remove(later);
      await repo.remove(earlier);
    }
  });
});
