# Library API Spike — findings (Task 1, 2026-08-28)

Throwaway probes run under Bun 1.3.14 with `jose@6.2.10`, `@better-auth/api-key@1.7.1`,
`@modelcontextprotocol/{server,client}@2.0.0`. These are the VERIFIED shapes the
later tasks build against.

## jose — sealed delivery (works, exact recipe)

- Bun's `crypto.subtle.generateKeyPair` is **missing** in Bun 1.3.14; jose works
  anyway because it falls back to `node:crypto` internally. Only ever generate/
  import keys **through jose**, never `crypto.subtle` directly.
- Keypair: `generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true })`
  (alg name is `"ECDH-ES"`, NOT `"ECDH"`; also for `importJWK`).
- Seal (N recipients, one ciphertext):
  ```ts
  const ge = new GeneralEncrypt(new TextEncoder().encode(text));
  ge.setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM" }); // alg goes in SHARED protected header
  for (const r of recipients)
    ge.addRecipient(await importJWK(r.publicJwk, "ECDH-ES")).setUnprotectedHeader({ kid: r.principalId });
  const envelope = await ge.encrypt(); // General JWE object → store JSON.stringify(envelope)
  ```
  Gotchas: `encrypt()` takes NO argument in this path and returns an **object**,
  not a string. `addRecipient(key, opts)` ignores positional headers for `kid` —
  you MUST chain `.setUnprotectedHeader({ kid })`; the recipient entry then looks
  like `{ encrypted_key, header: { epk, kid } }` (kid plaintext, server-readable).
- Open: parse JSON, find `recipients.find(r => r.header?.kid === ownPrincipalId)`,
  rebuild the **flattened** shape and decrypt:
  ```ts
  const { plaintext } = await flattenedDecrypt(
    { protected: env.protected, header: mine.header, encrypted_key: mine.encrypted_key,
      iv: env.iv, tag: env.tag, ciphertext: env.ciphertext },
    await importJWK(ownPrivateJwk, "ECDH-ES"),
  );
  ```
- Wrong/non-recipient key → `ERR_JWE_DECRYPTION_FAILED`. 5-byte msg, 2 recipients
  ≈ 625 B envelope (~+220 B per extra recipient).

## MCP SDK v2 — export names (verified)

- `@modelcontextprotocol/server`: `McpServer` ✓ (top-level), plus `Server`.
- `@modelcontextprotocol/server/stdio`: `StdioServerTransport`, `serveStdio`.
- `@modelcontextprotocol/client`: `Client`. `/stdio`: `StdioClientTransport`.
- `zod` is NOT a resolvable transitive dep → added as direct dep, pinned `4.5.2`.

## @better-auth/api-key 1.7.1 — endpoint shapes (verified against a live Bun+SQLite instance)

- **Migrations**: `getMigrations` takes the FULL `BetterAuthOptions` (it creates the
  `apikey` table only when the options include the plugin). Our
  `runAuthMigrations()` currently passes `{ database }` only → **must pass the shared
  options object incl. plugins** (auth.ts: extract the options literal and reuse).
- Table is `apikey`, columns are **camelCase** in SQL: `id, configId, name, start,
  referenceId, prefix, key, refillInterval, refillAmount, lastRefillAt, enabled,
  rateLimitEnabled, rateLimitTimeWindow, rateLimitMax, requestCount, remaining,
  lastRequest, expiresAt, createdAt, updatedAt, permissions, metadata`.
- `auth.api.createApiKey({ body: { name, userId, expiresIn, metadata, permissions } })`
  **works server-side without a session**. Returns the row incl. plaintext `key`
  (once) + `id`. `referenceId` (not userId) is the stored owner column.
  - `expiresIn` is in **seconds** but the default `minExpiresIn` boundary is
    **1 day** — 3600 failed ("smaller than the predefined minimum"). Session keys:
    use `604800` (7 d) or omit (no expiry).
  - `metadata` must be an **object** (JSON.stringify is rejected); it comes back as
    an object.
- `auth.api.verifyApiKey({ body: { key, permissions? } })` →
  `{ valid: boolean, error: {code} | null, key: <row incl. metadata/permissions/id> }`.
  Insufficient permissions surface as `valid:false, code:"KEY_NOT_FOUND"` (opaque
  on purpose). Disabled key → `KEY_DISABLED`.
  - `body.key` is **required** for server-side calls; `customAPIKeyGetter` applies
    only to HTTP-routed requests → **drop `customAPIKeyGetter`** and extract the
    bearer token ourselves in authGuard (decision recorded here).
- `updateApiKey` / `deleteApiKey` / `listApiKeys` **require a session** —
  server-side calls fail `UNAUTHORIZED_SESSION` / `Unauthorized`. → **SQL fallbacks**
  for the lifecycle (verified working end-to-end):
  - revoke: `UPDATE apikey SET enabled = 0 WHERE id = ?` (verify then returns KEY_DISABLED)
  - extend: `UPDATE apikey SET expiresAt = datetime('now', '+7 days') WHERE id = ?`
    (verify then valid again) → **amendment #7 resolves to the TRUE branch:
    session keys DO expire (7 d) and ARE extended.**
  - list (admin UI): `SELECT id, name, start, enabled, createdAt, expiresAt FROM apikey
    WHERE referenceId = ?` (never select `key` — it holds the hash).

## better-auth pin

1.7.1 (matches installed better-auth; plugin version-aligned; CVE-fixed line).
