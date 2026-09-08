# Security Audit — 2026-08-30 (full-codebase, threat-model-scoped)

**Branch:** `chore/security-audit-2026-08` (base `main@91c5f3e`)
**Scope:** encryption architecture (channel E2EE, identity keys), API keys and token
lifecycle, auth/sessions/WS, isolation/paths/command surface, frontend/browser surface.
**Method:** five parallel domain audits (fresh reviewers per area), every finding
re-verified against the code by the controller before any fix; fixes landed as
small waves with disjoint file ownership, each TDD'd. Judged strictly against the
stated threat model (`.claude/rules/security-context.md`): a local / trusted-network
service — internet-grade hardening wishes are *not* findings; breaches of the
documented invariants *are*.

**Status: all five audit areas reported; all 18 findings fixed across six
waves; consolidated gates green; awaiting the whole-branch adversarial
review verdict in §5; all six review Minors closed in `20510fa`,
full suite re-run green (backend 416/416).**

## 1. Findings fixed on this branch

Severity is relative to the stated model. "Actor confusion" = a machine bearer
credential (session token / system key) reaching a cookie-only surface, or one
principal reaching another's.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| H1 | High | **No trust anchoring for channel peer keys.** `mote_post_channel` sealed to whatever JWK the roster (served by the relay) reported, every time — a hostile server could swap its own key into a victim's slot and read everything, undetectable by the sender. Violated the E2EE premise that the relay is untrusted. | `4441003` — TOFU pin store (`mcp/pin-store.ts`): first-seen peer JWK pinned at 0600 `peers.json`, later posts require byte-equality or the post aborts *before* sealing; corrupt pin file quarantined and the post refused (never a silent pin reset). Escape hatch `MOTE_CHANNEL_PIN=trust` (typo/absent ⇒ strict). |
| M1 | Medium | **Shell injection via env-var KEYS into the harness command.** Pane start builds `KEY=value` pairs with values shell-quoted but keys spliced raw, and tmux runs the command through `sh -c`; a profile env key like `A=x B=$(...)` executed code in the pane. | `11e2977` — keys validated `^[A-Za-z_][A-Za-z0-9_]*$` at command build; invalid keys throw before spawn (command build moved inside the create-try so a failed build rolls back the row). |
| M2 | Medium | **Folder explorer allowed the whole filesystem** behind a docstring claiming an allowlist: `allowedRoots` included `/`, making the traversal guard vacuous. | `11e2977` — cookie-only actor, honest docstring, optional `MOTE_FS_ROOT` confinement enforced per-request. |
| M3 | Medium | **Any bearer token could mint a WS attach token** (`POST /api/auth/ws-token` used `user.id` = session *owner*), so a running agent could attach to a *sibling* session's terminal — reading and writing keystrokes — despite the "scoped by permissions" claim. | `d56bc2e` — minting is cookie-only (machine creds 403); terminal attach remains a human action. |
| M4 | Medium | **Profile CRUD was any-bearer** and `profile.env` merges *over* `MOTE_*` by design, so a session token could rewrite any profile (including its `MOTE_API_TOKEN`/env) and intercept the next session's credentials — escalation between agents, not just tampering. | `d56bc2e` — profile create/update/delete are cookie-only (reads stay open for `mote_list_profiles`); env-var *name* validation at the API returns 400 before the storage layer's later command-build rejection. |
| M5 | Medium | **Settings admin gate was role-only**: an admin-owned *session token* passed `isAdmin(user)`, letting a machine credential flip the registration gate. | `d56bc2e` — admin GET/PATCH require `actor === "cookie"` (matches the documented "admin surfaces are cookie-only" invariant). |
| M6 | Medium | **Identity registration accepted any JSON object as a public key.** A garbage key registered fine and then made `seal()` throw for *every* member of *every* channel the registrant joined — channel-wide denial of service by any bearer. | `e7e47e8` — `api/public-jwk.ts::assertImportablePublicJwk`: `kty=EC`, `crv=P-256`, base64url `x`/`y`, private component `d` rejected, then an actual `importJWK(..., "ECDH-ES")` round-trip (the same operation seal performs); single generic 400, no oracle. |
| M7 | Medium | **`recipientIds` was trusted without comparing it to the envelope.** A poster could declare recipients `[B]` while sealing only to itself: B stores a row it can never decrypt, and cursor-advancing reads silently skip undecryptable posts — a silent-delivery attack. Spec §'recipients mismatch → 400' was unimplemented. | `e7e47e8` — `validateEnvelope` now requires every recipient slot to carry a non-empty `header.kid` and the kid SET to equal `recipientIds` exactly (plaintext-kid inspection is the sanctioned server-side filter mechanism, architecture §3; ciphertext still never parsed). |
| L1 | Low | **`pipe-pane` log path was escaped with `JSON.stringify`, not shell quoting** — a crafted session log path could break out of the `sh -c` argument tmux hands to `pipe-pane`. | `11e2977` — shared `shellQuote` from `@internal/harnesses`. |
| L2 | Low | **Non-members could append to a channel log** — the service checked recipient membership only, so any bearer could forge posts into a channel it never joined. | `e7e47e8` — author must be a member (403). The MCP tool path is unaffected (it auto-joins before posting). |
| L3 | Low | **Identity store was fail-open**: any read/parse error on an *existing* keypair file was treated as "no key yet" → a fresh keypair silently overwrote it, orphaning the session's decryptable history (e.g. one transient EIO). | `e7e47e8` — only ENOENT generates fresh; anything else quarantines the unreadable file best-effort and throws. |
| L4 | Low | **Token-lifecycle plumbing gaps**: spawn-failure backoff path rotated the bearer key forever without a session; a swallowed revoke left `apiKeyId` pointing at a key believed dead; restart/terminate raced on unconditional updates (TOCTOU between the status read and the key rotation). | `4a3d2ae` — every attempt advances `backoffCount` (give-up reached in ≤5 sweeps); `#revokeTokenOrUnlink` at all five revoke sites (failed revoke falls back to clearing `apiKeyId`, which the guard's link-check turns into a 401); pre-spawn re-read + `updateIfRunning` conditional revival kills the orphan pane instead of resurrecting a terminated row. Incidental find: the Kysely bun-sqlite dialect returns `numUpdatedRows`, not the typed `numUpdated` — pinned by regression test. |
| M8 | Medium | **The documented prod placeholder-secret boot refusal did not exist.** better-auth 1.7.1's guard rejects only its OWN `DEFAULT_SECRET` string; the repo placeholder (`constants.ts`) sailed through, so `NODE_ENV=production` with `BETTER_AUTH_SECRET` unset silently signed cookies with a publicly known key — forgeable `better-auth` endpoint sessions (app routes stayed safe: `authGuard` is DB-backed by construction). | `7c36b4a` — `assertProdAuthSecret()` throws at `index.ts` module top level before any boot side effect; dev/test keep the default. The `security-context.md` claim is now true (app-level guard). |
| M9 | Medium | **`GET /api/profiles` returned `envJson` to bearer keys** — the write-path cookie-only fix (d56bc2e) missed the read path: any session token (ps-visible by design) could harvest every operator secret in profile env; the MCP tool projects rows to `{id,name,harnessId}` precisely so agents never see env. | `7c36b4a` — `envJson` redacted to `null` for non-cookie actors on the GET; cookie/browser editor unchanged. |
| L5 | Low | **`/api/setup/harnesses` GET+PATCH stayed unauthenticated forever**, beyond the documented `/status`-only carve-out: pre-auth enumeration of installed tooling + a persistent machine-config write. | `7c36b4a` — public only while the instance has no users (boot wizard); afterwards GET needs any authenticated actor, PATCH a cookie session. |
| L6 | Low | **The bearer permission ceiling missed the browser-only surfaces** — workspaces, uploads, bookmarks ran under bare `authGuard`, so a zero-grant token would silently act as its owner the moment reduced-grant tokens exist. | `7c36b4a` — cookie-only on all of them (the `mote mcp` endpoint census confirms no machine consumer); MCP-used surfaces keep `requirePerm`. |
| L7 | Low | **7-day cookieCache** let a copied/stale cookie jar pass better-auth's own session endpoints for up to 7 days after sign-out (app routes never depended on it — the guard is DB-backed). | `7c36b4a` — maxAge 7d → 5 min, rationale documented in config. |
| L8 | Low | **First-admin TOCTOU + fail-open registration gate**: two concurrent first sign-ups both became admin; an unparseable `allow_registrations` value re-opened registration. | `7c36b4a` — promotion is one `INSERT … CASE WHEN NOT EXISTS` under the write lock (`ON CONFLICT DO NOTHING`, roles never overwritten); the gate now fails closed on anything but explicit `true` (missing row = open = pre-setup default). |

## 2. Consciously carried (documented, not defects under the model)

- **No sender signatures.** A channel member can still post under another
  member's `kid` — envelopes carry no author signature. The E2EE property is
  confidentiality against the relay, not member-to-member authenticity; L2
  closed the practical hole (only members can write at all). Out-of-band
  verification or per-message ECDSA signing would be the general fix; deemed
  over-engineering for a trusted-teammates instance.
- **`MOTE_CHANNEL_PIN=trust`** opt-out of H1 pinning — for operators who accept
  relay honesty. Absent/typo ⇒ strict.
- **Bearer tokens visible in `ps` / tmux pane metadata** to any local OS user —
  explicitly accepted by the security-context rules; the E2EE boundary never
  covered a host-compromising local user.
- **Upload symlink containment**: uploads land under `<workingDir>/.mote/uploads`
  on the same uid as the backend; a same-uid attacker already owns everything.
  Checked and accepted.
- **Permissive CORS, no rate limit beyond login, no string-length caps** —
  documented posture for a loopback/trusted-network service.
- **`/api/users` roster readable by bearer keys** (by design in the shipped
  auth-experience feature): rows are operator-visible emails/roles, and
  `viewerIsAdmin` stays false for bearers — machine creds never see the admin UI.

## 3. Verified clean (audited, no finding)

Crypto/channels: envelope crypto (jose GeneralEncrypt, ECDH-ES+A256KW /
A256GCM, per-message ephemeral CEK, pinned alg/enc); recipient-filtered reads
(server never stores plaintext). Auth (`.git/sdd/audit-auth-ws.md` audited the
whole substrate clean beyond its six findings): session-key ↔ row link
(server-written `sessions.apiKeyId` + system-user `referenceId` checks defeat
forged key metadata); bearer-kind separation; self-service key minting blocked
at the plugin mount; api-key verify semantics (disable revokes instantly —
cache is secondary-storage-only); WS single-use token issue→consume path
(delete-before-expiry, owner re-check at attach, no fallthrough to cookie on a
bad token); login rate-limit route ordering (no trailing-slash/case bypass);
IDOR sweep across sessions/uploads/workspaces/bookmarks/identities; secret
leakage sweep (no plaintext key in any response or log); no non-constant-time
secret comparisons in app code; no session fixation. Frontend
(`.git/sdd/audit-frontend.md`): **zero findings** — no XSS sink, `safeRedirect`
at every navigation site, PTY output reaches only xterm or React-escaped text,
no state-changing GETs, no secrets in fixtures or client storage, no token
URL/log exposure. Command surface: curated-env deny-by-default (`env -i`),
literal `send-keys` (no second shell), DB parameterization throughout,
static-plugin dist-root guard.

## 4. Carried deliberately

- **Test-infra defect** (found by the authz-R2 agent, not security): test mode
  used the URI string `file::memory:?cache=shared`, but Bun treats URI strings
  as file names — every test process was sharing one persistent literal file
  in `apps/backend/` (the real cause of the audit-week `SQLITE_BUSY` flakes).
  **Since fixed on this branch** (`9fd511b`): per-process temp file with
  preload-level cleanup (`bun test` never fires exit listeners), plus the one
  test that was green only because of the pollution. Related CI repair:
  the harness-enable suite's positive path no longer assumes a locally
  installed claude binary (`4f3d74d`) — the Test workflow has been red on
  every main push since the harness registry shipped; this fixes it.

## 5. Final gates

Consolidated, run exclusively after all fix agents quiesced:
`bun run verify-types` 16/16 · `bun run lint:check` 6/6 · `bun run test`
15/15 tasks (backend 408/408, 0 fail) · `bun run test:e2e` 22 passed + 1
intentional skip — identical to the pre-audit baseline. Whole-branch
adversarial review: appended below.

**Whole-branch adversarial review (opus, `.git/sdd/audit-final-review.md`):**
verdict **merge-ready — yes**; 0 Critical, 1 Important (report/branch
contradiction at tip — discharged by this very commit), 6 Minor (all closed
in the follow-up commit: setup-parser reuses the guard's credential
derivation, realpath confinement in the folder explorer, fail-closed parse
for non-object identity files, extra fallback/quote/quiescence tests,
`IS_TEST`-guarded probe seam, redaction-pinning assertion + TOFU
key-recovery runbook sentences in `docs/architecture.md` — landed as
`20510fa` with the full suite re-run green, backend 416 pass / 0 fail.
Two noted follow-ups, deliberately not in this branch: `setNudgeTransport-
ForTests` still lacks the `IS_TEST` guard (file outside the minors' scope),
and with `MOTE_FS_ROOT` set a broken symlink now 403s where it 404'd (the
honest refusal split, pinned by tests). Empirical
highlights: old first-admin logic double-admin'd 20/20 in the discriminator
probe while the new single statement cannot split; full MCP/frontend/e2e
census confirms no consumer of any cookie-only conversion; 163 scoped
security tests re-run green.
