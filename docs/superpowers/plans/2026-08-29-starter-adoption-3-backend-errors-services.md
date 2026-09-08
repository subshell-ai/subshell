# Increment 3 — Backend Error Format + Service Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the starter's shared error contract (`errId`-tagged `ApiError` bodies via a global `onError`) across every route WITHOUT changing any status code, and introduce the `ApiContext`/services layer by converting the three largest route files (sessions, workspaces, channels) into per-resource directories backed by thin services.

**Architecture:** One global `errorHandlerPlugin` (`onError`, `.as("global")`) serializes every thrown error into the body shape described by `ApiErrorResponseSchema`; mote's existing throw-classes (`UnauthorizedError`, `ForbiddenError`, `HttpError`, route-local `status`-carriers) map onto it preserving status and message text. `ApiContext` (db + per-request loglayer + repos + services) is injected by `contextPlugin`; converted routes call `ctx.services.*`. Business truth stays where it lives (`session-manager.service.ts` etc.) — services wrap, they do not fork logic.

**Tech Stack:** Elysia 1.4.29, TypeBox `t`, `@internal/backend-errors` (upgraded first), `@loglayer/elysia` (already a dep), bun test.

**Spec:** `docs/superpowers/specs/2026-08-29-starter-structure-adoption-design.md`, Increment 3.
**Templates (read-only reference, do NOT edit):** `/home/theo/projects/bun-elysiajs-starter-turbo-monorepo/apps/backend/src/{lib/api-error.ts,lib/context.ts,plugins/context.plugin.ts,plugins/error-handler.plugin.ts,schema/error.type.ts,schema/index.ts,services/base.service.ts}` and the starter's `api/notes/` directory for the route-split shape.

## Global Constraints

- **Status codes must not change anywhere.** Existing tests and the e2e suite assert them (`401`, `400`, `404`, `409`…); the error-body change is JSON-structure only.
- `errId` = `nanoid(12)` (already how `ApiError` works); safe metadata ONLY via `metadataSafe` — never leak internals in production bodies (`toJSONSafe` in prod, `toJSON` in dev).
- Static imports only. JSDoc on every new export. Interface properties documented.
- Files ≤ ~300 lines; split per the existing code-style rule.
- Verification gate every task: `bun run verify-types && bun run lint:check && bun run test`; from Task 2 onward also `bun run test:e2e` (the 10 e2e specs must stay green — they assert statuses, not bodies).
- Do NOT convert routes outside the big three; they inherit the error format via `onError` for free.
- Conventional commit types from commitlint enum.

## Known verified facts (as of 2026-08-29)

- `packages/backend-errors/src/error-codes.ts` is byte-identical to the starter's; `lib.ts` differs ~76 diff lines (mote's imports `ajv`'s `ErrorObject`; starter's modernized to a structural `ApiValidationErrorItem`). Port the starter's `lib.ts`.
- `@loglayer/elysia@2.4.0` exports `elysiaLogLayer`; `nanoid@6.0.1` and `loglayer@9.4.0` are backend deps already.
- mote currently has NO global `onError`; thrown `status`-carrying errors serialize via Elysia defaults (text body). `apps/backend/src/api/auth-guard.ts` owns `UnauthorizedError` (401), `ForbiddenError` (403), `HttpError(status, message)`; other routes declare local carriers (e.g. `BookmarksError` in `bookmarks.route.ts`).
- Elysia exposes `status()` in handlers; the starter prefers RETURNING `status(code, apiErrorBody(...))` for typed narrowing, but mote's migration path is: keep throwing; `onError` maps. Converted routes MAY return `status(...)` where it costs nothing.
- Consumers of raw error text to update in Task 2: `apps/frontend/src/lib/api.ts` (`apiFetch` builds `ApiError(status, rawText)`) and `apps/backend/src/mcp/api-client.ts:43-44` (same pattern). `setup.tsx` already reads `body?.message` (no change needed). E2E 02/03/07 assert STATUS CODES ONLY — unaffected.

---

### Task 1: Upgrade `@internal/backend-errors` to the starter's modernized lib

**Files:**
- Modify: `packages/backend-errors/src/lib.ts` (replace with starter's content, keeping any mote-only exports — diff first)
- Modify: `packages/backend-errors/package.json` (drop the `ajv` dependency + peerDependency if the starter no longer lists it)
- Modify as needed: `packages/backend-errors/src/__tests__/*`

**Interfaces:**
- Produces: `ApiError`, `createApiError`, `throwApiError`, `ApiErrorShort`, `ApiValidationError`, new `ApiValidationErrorItem` — all from `@internal/backend-errors` (import specifiers unchanged).

- [ ] **Step 1:** `diff packages/backend-errors/src/lib.ts /home/theo/projects/bun-elysiajs-starter-turbo-monorepo/packages/backend-errors/src/lib.ts`. Read BOTH files. Confirm every mote-side difference is the ajv-removal/typing modernization and NOT a mote-only feature (grep mote for imports from the package: `grep -rn "backend-errors" apps packages --include=*.ts -l`). If mote has a unique export the starter lacks, KEEP it.
- [ ] **Step 2:** Copy the starter's `lib.ts` over mote's (Write tool), re-adding any mote-unique piece found in Step 1. Update `package.json` to drop `ajv` (deps + any overrides block), run `bun install`.
- [ ] **Step 3:** Run the package's tests (`cd packages/backend-errors && bun test src`) then the full gate `bun run verify-types && bun run lint:check && bun run test`. Fix fallout (type-level only — behavior is identical by construction; if a backend test fails on a behavioral difference, that is a finding: investigate before proceeding).
- [ ] **Step 4:** Commit: `git add packages/backend-errors bun.lock && git commit -m "refactor(backend-errors): port starter's validator-agnostic types, drop ajv dependency"`

---

### Task 2: Shared error body everywhere — schema, apiErrorBody, global onError, consumer compat

**Files:**
- Create: `apps/backend/src/schema/error.type.ts`, `apps/backend/src/schema/index.ts`
- Create: `apps/backend/src/lib/api-error.ts`
- Create: `apps/backend/src/plugins/error-handler.plugin.ts`
- Modify: `apps/backend/src/server.ts` (mount errorHandlerPlugin)
- Modify: `apps/backend/src/constants.ts` (add `IS_PROD` export if absent — check first)
- Modify: `apps/backend/src/mcp/api-client.ts` (parse structured error bodies for `message`)
- Modify: `apps/frontend/src/lib/api.ts` (+ its `__tests__` if none exists, create one for this behavior)
- Test: `apps/backend/src/lib/__tests__/api-error.test.ts`, `apps/backend/src/plugins/__tests__/error-handler.test.ts`, `apps/frontend/src/lib/__tests__/api-error-body.test.ts`

**Interfaces:**
- Consumes: Task 1's `createApiError`/`ApiError`/`BackendErrorCodes`.
- Produces: `apiErrorBody(params): ApiErrorResponse` (`@/lib/api-error.js`); `errorHandlerPlugin`; `ApiErrorResponseSchema` + `apiModels` plugin registering the `"ApiErrorResponse"` response name (`@/schema/index.js`); `IS_PROD` from constants. Body shape: `{ errId, code, message, statusCode, reqId?, metadata? }`.

- [ ] **Step 1: Write failing tests first** for the three mapping branches (bun test, real Elysia app via `app.handle(new Request(...))` like existing route tests do — see `src/api/__tests__/helpers/`):
  - `apiErrorBody` returns errId/code/message/statusCode, logs nothing on `doNotLog`, prod-shape excludes `stack`.
  - Handler that throws `new HttpError(404, "nope")` → response 404, JSON body `{ code: "NOT_FOUND_ERROR", message: "nope", errId: <string>, statusCode: 404 }`.
  - Handler that throws `UnauthorizedError` → 401 `INVALID_CREDENTIALS`; `ForbiddenError` → 403 `ACCESS_DENIED`; a class with `.status = 409` → `EXISTS_ERROR`; `.status = 400` → `BAD_REQUEST`; unmapped status (e.g. 418) → `BAD_REQUEST`? NO — use `INTERNAL_SERVER_ERROR` only for no-status/unknown; a status-carrier with an unmapped status keeps its status and gets `code` = closest by `BackendErrorCodeDefs` reverse lookup, falling back to `BAD_REQUEST` for 4xx and `INTERNAL_SERVER_ERROR` for 5xx. Assert the fallback rule you implement.
  - Handler failing body validation (`t.Object({ name: t.String() })` with JSON `{}`) → 400 with `code: "INPUT_VALIDATION_ERROR"` (was Elysia's 422 — NOTE: this intentionally changes ONE status: validation failures move 422→400 per the starter; verify mote has no test asserting 422 first (`grep -rn "422" apps packages e2e --include=*.ts`); if any exist, update them and call it out in the commit message).
  - Handler throwing `new Error("boom")` → 500, body message does NOT contain "boom" in prod-shape… in dev it may; assert `code === "INTERNAL_SERVER_ERROR"` and errId present.
- [ ] **Step 2:** Create `schema/error.type.ts` + `schema/index.ts` from the starter's (Write tool; the starter's files are already TypeBox/`t`-based — port verbatim, then create the tiny `apiModels` plugin in `schema/index.ts`: `export const apiModels = new Elysia({ name: "api-models" }).model({ ApiErrorResponse: ApiErrorResponseSchema }).as("global")`).
- [ ] **Step 3:** Create `lib/api-error.ts` from the starter, with ONE deviation: where the starter's `error-handler.plugin.ts` is the only logger, mote's routes are not request-logged yet (Task 3 adds per-request log) — use `getLogger()` from `@/utils/logger.js` exactly as the starter does (it exists in mote; confirm the export name by reading `src/utils/logger.ts`).
- [ ] **Step 4:** Create `plugins/error-handler.plugin.ts` = starter's three branches PLUS a new branch BEFORE the fallback for mote's `status`-carriers: `const st = (error as any)?.status; if (typeof st === "number" && st >= 400 && st <= 599) { … createApiError({ code: codeForStatus(st), message: error.message, doNotLog: st < 500 }) … preserve st }`. Import nothing from auth-guard (avoid cycles) — duck-type on `.status`.
- [ ] **Step 5:** Mount in `createApp()` — FIRST plugin used (before routes) so it owns all errors: `.use(errorHandlerPlugin)`. Verify `IS_PROD` exists in constants (add `export const IS_PROD = process.env.NODE_ENV === "production";` if missing, with JSDoc).
- [ ] **Step 6:** Consumer compat — `apps/backend/src/mcp/api-client.ts`: when parsing a non-ok response, try `JSON.parse(text)` and use `parsed?.message ?? text`. `apps/frontend/src/lib/api.ts`: same in `apiFetch` — parse JSON body, extract `message` (keep the `API ${status}: ${message}` format so no UI copy changes), and stash `code`/`errId` on the frontend `ApiError` class as optional readonly fields. Add/extend frontend unit tests: JSON error body yields clean message; legacy text body still yields text; 500-shaped JSON yields message.
- [ ] **Step 7:** Full gate + `bun run test:e2e` (statuses unchanged must keep all 10 green). Existing backend route tests that assert error TEXT (channels-route.test.ts `text`) may need `.toContain(...)` targets adjusted ONLY if they broke — the message text survives inside the JSON string, so most pass unchanged.
- [ ] **Step 8:** Commit: `git commit -m "feat(backend): one structured error body for every route (errId + code), consumers parse it"`

---

### Task 3: ApiContext + contextPlugin + BaseService, with the sessions route as first consumer

**Files:**
- Create: `apps/backend/src/lib/context.ts`, `apps/backend/src/plugins/context.plugin.ts`, `apps/backend/src/services/base.service.ts`, `apps/backend/src/services/index.ts` (create if absent)
- Create: `apps/backend/src/services/sessions.service.ts`
- Create: `apps/backend/src/api/sessions/` — split of today's `apps/backend/src/api/sessions.route.ts` (283 ln): `index.ts` + one `<verb>-session.route.ts` per endpoint (read the file: expect list/get/create/terminate/restart/log-tail/notes-ish routes) + `__tests__/` (MOVE existing `src/api/__tests__/sessions-*.test.ts` files here, updating import paths)
- Delete: `apps/backend/src/api/sessions.route.ts` (after split), update `apps/backend/src/api/routes.ts` import
- Test: `apps/backend/src/lib/__tests__/context.test.ts`

**Interfaces:**
- Consumes: Task 2's `apiErrorBody`/`ApiErrorResponse`; existing `session-manager.service.ts` (the business truth — SessionsService DELEGATES to it, adds no parallel logic).
- Produces: `ApiContext` with `log`, `db`, `repos` (readonly — for `getRequestlessContext()` users in Task 6), `services`; `contextPlugin` exposing `ctx` (+ `log` via `elysiaLogLayer`); `Services` interface (`{ sessions: SessionsService }` — grows in Tasks 4–5); `getRequestlessContext()`. Converted `api/sessions/*` handlers call `ctx.services.sessions.*` and mount `.use(contextPlugin).use(authGuard)`.

- [ ] **Step 1:** Read the starter's `lib/context.ts`, `plugins/context.plugin.ts`, `services/base.service.ts`. Port each into mote with these adaptations: `Repositories` — mote has NO `db/repositories/index.ts`-wide `Repositories` type (check: `cat apps/backend/src/db/repositories/index.ts`); construct the repos the services actually need (sessions: SessionsRepository + whatever sessions.route.ts instantiates today) — a `Repositories` interface listing them lives in `services/index.ts` or `db/repositories/index.ts` (follow whatever index.ts already exports). `Services` starts as `{ sessions: SessionsService }`.
- [ ] **Step 2:** context.plugin: `elysiaLogLayer({ instance: logger, requestId: () => nanoid(12) })` + `.resolve(({ log }) => ({ ctx: new ApiContext({ db, log }) })).as("global")` (types: cast log as the starter does). Confirm `logger` export name in `src/utils/logger.ts`.
- [ ] **Step 3:** Test `getRequestlessContext()` returns a stable singleton with `repos`/`services` populated (bun test; in-memory DB applies automatically via test-preload).
- [ ] **Step 4:** Write `SessionsService extends BaseService`: for EVERY handler in today's `sessions.route.ts`, add one method with a JSDoc that performs exactly what the handler did (call `getRouteContext()`-free; session-manager functions are imported statically). NO behavior change; NO parallel session-manager rewrite. Keep `validateWorkingDir` exported from its current module (other routes import it).
- [ ] **Step 5:** Split the route file into `api/sessions/`: one Elysia instance per endpoint named after its operationId (e.g. `list-sessions.route.ts`, `create-session.route.ts`…), each `.use(contextPlugin).use(authGuard)` (keep whatever guards the original had per-endpoint — READ the original; some endpoints may be admin-gated or bearer-only), handler body = one call into `ctx.services.sessions.…` (+ `status()`/`apiErrorBody` for expected failures where the original threw `HttpError`). `index.ts` mounts them under `new Elysia({ prefix: "/api/sessions" })` preserving original order. Move sessions tests into `api/sessions/__tests__/` with fixed imports; run them: all must pass UNCHANGED (status + body assertions).
- [ ] **Step 6:** Full gate + e2e (spec 06 creates a session through this route — it must stay green). Commit: `git commit -m "refactor(backend): ApiContext + services layer; sessions route converts first"`

---

### Task 4: Convert workspaces to service + per-resource directory

**Files:**
- Create: `apps/backend/src/services/workspaces.service.ts`; `apps/backend/src/api/workspaces/` (split of `workspaces.route.ts`, 290 ln) + `__tests__/` (move `workspace-layout.test.ts`, `workspaces-route.test.ts`, `workspace-layout.ts` helper if route-specific — READ its imports; if shared with other code it stays put)
- Modify: `apps/backend/src/services/index.ts`, `apps/backend/src/lib/context.ts` (register `workspaces`), `apps/backend/src/api/routes.ts`
- Delete: `apps/backend/src/api/workspaces.route.ts`

**Interfaces:** Consumes Task 3's context/services; `WorkspacesRepository`/`WorkspacePanesRepository` (and whatever the route uses today). Produces `Services.workspaces`, converted routes with typed 200s + `"ApiErrorResponse"` error variants.

- [ ] **Step 1:** Read `workspaces.route.ts` + `workspace-layout.ts` end-to-end; note every repo/service instantiated and every thrown error class. Write `WorkspacesService` mirroring handlers one-to-one (JSDoc each method). Behavior-preserving ONLY — layout validation logic moves verbatim or stays in `workspace-layout.ts` and the service imports it.
- [ ] **Step 2:** Register in `Services` + `ApiContext.init()` (repos for workspaces + panes). Split routes per Task 3's directory pattern. Add `"ApiErrorResponse"` error variants to the converted routes' `response` maps (typed errors: this is the increment's payoff for Eden typing).
- [ ] **Step 3:** Move + fix imports of existing tests; full gate + e2e (spec 05 drives these routes). Commit: `git commit -m "refactor(backend): workspaces route -> service + per-resource directory"`

---

### Task 5: Convert channels to service + per-resource directory

**Files:**
- Create: `apps/backend/src/services/channels.service.ts`; `apps/backend/src/api/channels/` (split of `channels.route.ts`, 324 ln) + `__tests__/` (move `channels-route.test.ts`)
- Modify: `apps/backend/src/services/index.ts`, `apps/backend/src/lib/context.ts`, `apps/backend/src/api/routes.ts`
- Delete: `apps/backend/src/api/channels.route.ts`

**Interfaces:** Consumes Tasks 3–4's context; `ChannelsRepository`, `ChannelPostsRepository`, `IdentitiesRepository`, `Nudge` (`services/channels/nudge.ts`). Produces `Services.channels`; converted routes keep the structural envelope validation EXACTLY (spec's security rule: never parse ciphertext; keep `^[a-z0-9][a-z0-9-]{0,63}$` slug rule and 600 s wait clamp — read the original and preserve them).

- [ ] **Step 1:** Read `channels.route.ts`; write `ChannelsService` one-to-one. Long-poll read loop stays inside the service method (its `wait` clamp preserved). `requirePerm` stays in route handlers (it is a transport concern, not business logic).
- [ ] **Step 2:** Split into directory (verbs: create/list/get-or-list-one/members-add/members-list/posts-post/posts-get/cursor-get — derive the actual set from the file), typed response variants, move tests. The e2e channels spec (07) is the external contract: it must pass unchanged.
- [ ] **Step 3:** Full gate + e2e. Commit: `git commit -m "refactor(backend): channels route -> service + per-resource directory"`

---

### Task 6: Non-request callers on `getRequestlessContext()`, docs sync, final gate

**Files:**
- Modify: `apps/backend/src/mcp/tools.ts`, `apps/backend/src/ws/*` (only where they hand-build repositories — grep `new .*Repository(db)` in `src/ws/` and `src/mcp/` to find exact sites; if none build repositories, this task is docs+gate only and says so)
- Modify: `apps/backend/AGENTS.md` (replace "There is no request-context/DI container today…" with the new truth: contextPlugin/ctx.services, error body format, `apiErrorBody`, ApiErrorResponse; list the per-resource dirs)
- Test: full gate

- [ ] **Step 1:** `grep -rn "new [A-Za-z]*Repository(db)" apps/backend/src/ws apps/backend/src/mcp` — convert those construction sites to `getRequestlessContext()` (or leave + document if they pass injected deps already).
- [ ] **Step 2:** Update `apps/backend/AGENTS.md`'s Architecture + a new "Error contract" subsection (structured body fields, `code`s, errId ↔ logs). Remove the now-false "no DI container today" sentence.
- [ ] **Step 3:** Full gate: `bun run verify-types && bun run lint:check && bun run test && bun run test:e2e`. All green. Commit: `git commit -m "docs(backend): document context/services and the structured error contract"`
