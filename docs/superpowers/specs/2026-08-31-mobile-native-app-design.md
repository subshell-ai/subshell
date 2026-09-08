# Mote Mobile: native iOS/Android companion

Date: 2026-08-31 · Status: approved design, pre-implementation

## Problem

A harness session is most useful when it runs unattended and worst when it stalls
waiting for a keystroke. The signal that it is waiting — `waitingSince`, stamped
server-side when a harness posts `/attention` or the idle watcher finds the pane
quiet — currently reaches the operator only through an open browser tab.

`2026-08-30-mobile-support-design.md` solved *viewing mote from a phone* and
`2026-08-30-harness-notifications-design.md` solved *ringing a browser*. Both stop
at the same wall: a web page cannot notify when nothing is open, cannot set an
app-icon badge, cannot offer a lock-screen action, and cannot hold a credential in
the Keychain behind a biometric. Those four are the entire justification for a
native app. This design adds it.

It is **not** a replacement for the web app. Authoring, workspaces, profiles, admin
and channels stay on the desktop. The phone is for leaving things running and being
called back.

## Decisions (from the design conversation)

- **Platform: React Native via Expo SDK 57**, in `apps/mobile` as `@internal/mobile`.
  Chosen over SwiftUI because the whole API contract is already TypeScript —
  `@internal/session-protocol` and `@internal/backend-client` are consumable as-is —
  and because it is the one path that works from this Linux dev box (cloud Macs do
  the iOS link step).
- **Phones *and* tablets**, targeting the devices already ratified: iPhone 15 Pro
  (393×852) and iPad Pro 11″ (834×1194 portrait, 1194×834 landscape).
- **Auth: the app is a better-auth cookie actor, not a bearer client.** No backend
  auth changes. See §Auth.
- **Instance discovery: the user types the origin.** Multi-instance is a first-class
  state (registry + active instance), because mote instances are self-hosted and may
  be numerous.
- **Live pane: xterm.js inside a WebView. Log: native list.** No hand-written ANSI
  parser or VT emulator in native code.
- **Push: Expo Push Service relay, with an opaque payload** — no session name or
  operator text ever crosses the relay. This deliberately *departs* from the
  2026-08-30 "no external relay" decision; §Push records why and what is bounded.
- **v1 scope: connect, list, log, act, push, badge, deep link, Face ID gate.**
  Gesture quick-actions and the prompt composer are follow-ups (§Follow-ups).
- **Notification actions are non-destructive: Open · Silence bell.** Nothing that
  terminates a session is reachable from a locked screen.
- **Libraries over custom** (standing preference): `expo-notifications`,
  `expo-router`, `expo-secure-store`, `expo-local-authentication`, `expo-crypto`,
  `react-native-webview`, `@shopify/flash-list`, `@xterm/xterm`, and
  `expo-server-sdk` server-side. Hand-rolled only where nothing exists.

## Auth: the app is a cookie actor

Two routes reject bearer actors **by design**, and both are on the mobile happy path:

- `apps/backend/src/api/ws-token.route.ts:26` — `actor !== "cookie"` → 403. A
  machine key must not be able to mint an attach token for *any* of its owner's
  sessions and inject keystrokes into a sibling agent's pane.
- `apps/backend/src/api/notifications.route.ts:41` — `browserOnly()` on all three
  push routes.

A phone held by a human **is** the interactive principal those gates are asking for,
so the app authenticates the way the browser does instead of asking those gates to
weaken:

```
POST {origin}/api/auth/sign-in/email {email, password}
  -> { redirect, token, url, user }      # token is in the BODY (verified, see below)
-> SecureStore: mote.token.<instanceId>
-> every request:  Cookie: <name>=<token>
```

Verified in the installed dependency rather than assumed: better-auth 1.7.1's
`signInEmail` returns the session token in the JSON body
(`dist/api/routes/sign-in.mjs:363`). Three consequences:

1. **The cookie *name* is scheme-dependent.** TLS instances issue
   `__Secure-better-auth.session_token`; the backend accepts either spelling
   (`apps/backend/src/lib/session-cookie.ts:13-28`). The transport picks the name
   from the origin's scheme, so plain-HTTP LAN origins keep working.
2. **Explicit `Origin`.** Production enforces better-auth's origin check
   (`.claude/rules/security-context.md`) and RN sends no `Origin` header. Sign-in
   sends `Origin: <origin>` — the instance's own origin, always trusted because it
   is derived from what the user typed, never from the request.
3. **A 401 mid-session is expected, not exceptional** (7-day session, 5-minute
   cookie cache; `src/auth.ts:26-41`). The transport clears the token, remembers the
   pending route, prompts, and resumes. It never silently retries.

What this unlocks with zero backend change: the whole sessions surface,
`POST /api/auth/ws-token`, `/ws`, `/api/events`, `POST /:id/uploads`,
`/api/files/explore|recent`, workspaces, and device enrollment.

## Transport: what is live, what is polled

- **One socket, one session.** The detail screen attaches
  `wss://{origin}/ws?session={id}&token={fresh}`. The token is single-use with a
  30 s TTL (`src/ws/ws-token.ts`), so it is minted per connect *and* per reconnect.
  Reconnect after a fixed 1500 ms on close code < 4000; on **≥ 4000 never retry** —
  that is the server's rejection signal (4000 attach failed, 4001 unauthorized,
  4004 not found/not running), identical to `use-session-ws.ts:63-64,128`.
- **The list polls; it does not use SSE.** `/api/events` is a full list snapshot
  every 1500 ms behind a single-use token, and RN has no `EventSource` — so SSE
  costs a token mint per reconnect and buys nothing. Foreground poll of
  `GET /api/sessions` at 3 s while anything is running or waiting, 15 s when
  quiescent, stopped in background, immediate on resume. Background wake-up is
  push's job, not the poll's.
- **Frames are reused verbatim** from `@internal/session-protocol`: outbound
  `{type:"replay"|"output", data?}`, inbound `{type:"input", data}` and
  `{type:"resize", cols, rows}`. JSON text, never binary. The browser client's
  full-history-per-attach rule applies unchanged: reset the emulator on the first
  `replay` of an attach, then append.

## Rendering: two panes, one source of truth

| Tab | Renderer | Source |
| --- | --- | --- |
| **Live** | `@xterm/xterm` 6.0.0 in `react-native-webview` | `/ws` `replay`+`output` frames |
| **Log** | native `@shopify/flash-list` | `GET /api/sessions/:id/log`, already `stripAnsi`-ed server-side (`session-manager.service.ts:905`) |

**The WebView owns no network and no secrets.** The backend's CORS allowlist
decides response headers for a matching `Origin` and does not gate WS upgrades — but
a page loaded from a bundled asset has an opaque origin, so any `fetch` from inside
it fails CORS, and placing the session token within WebView reach would defeat the
Keychain gate. Therefore React Native holds the socket, the token and every REST
call; the WebView is a renderer that receives frame strings via `injectJavaScript`
and posts keystrokes back through `onMessage`. The bundled page needs no network
privileges at all, which also means **xterm ships as a local asset, never a CDN
`<script>`** — a VPN-only instance would otherwise render a blank pane.

There is no maintained xterm-for-RN wrapper on npm (checked), and this is
deliberately not one: the page is ~60 lines of glue over stock xterm.

The two renderers will disagree by construction — the Log is a byte tail, the Live
pane is a screen image. They are never blended: the tab control says which one you
are reading, and neither writes state. Session truth comes from the polled list;
**the WebView never owns it.**

## Adaptive layout (phone / iPad)

One breakpoint, inherited rather than invented: **1024 px**, from
`WORKSPACE_TILING_MIN_WIDTH` in `apps/frontend/src/lib/breakpoints.ts`. RN has no
size classes, so `useIsWide()` here is `useWindowDimensions().width >= 1024` — which
keeps the existing rule that **iPad portrait is phone-shaped** and landscape is not,
and re-layouts live under Split View.

- **Compact:** bottom tabs — Sessions (badge = waiting count), New, Settings.
  Detail is pushed full-screen.
- **Regular:** left rail + list column + detail column, selection mirrored into a
  route param so deep links and state restoration land correctly. This is not
  cosmetic: a stretched phone UI on iPad is the classic App Store Guideline 4.1
  rejection shape.

Design tokens are ported from `apps/frontend/src/styles.css` into one JS module:
dark-only (no light mode exists to support), primary `oklch(0.78 0.12 250)`,
success emerald-400, **warning amber-400 = the "waiting for you" colour**,
destructive `oklch(0.65 0.2 25)`, radius 8 px, 44 px touch targets, terminal trio
bg `#0f1216` / canvas `#0a0c0f` / fg `#e4e4e7`.

## Push: relayed, but opaque

`2026-08-30-harness-notifications-design.md:15-17` rejected external relays because
they would leak session names to a third party. Native push genuinely cannot avoid a
relay on Android (FCM is the only channel) and would require the backend to own APNs
signing on iOS. The resolution keeps the *reason* for that decision rather than its
letter:

**What crosses exp.host** — nothing but the device token, a UUID, an event class, and
a count:

```
{
  to: "ExponentPushToken[…]",
  title: "mote",
  body:  KIND_COPY[kind],          // "A session needs you" — never row.name
  badge: waitingCount,             // integer for this user
  sound: "default",
  threadId: sessionId,             // groups the conversation only — NOT the replacer
  tag: sessionId,                  // Android: expo-notifications uses the tag as the
                                   // notification id, so a new event REPLACES the
                                   // session's earlier push (web-`tag` parity)
  collapseId: sessionId,           // iOS: apns-collapse-id, same replace semantics
  channelId: "mote-sessions",      // + legacy `_channelId` twin while the relay's
                                   // honoured name is unconfirmed on old lanes
  categoryId: "session",           // required for the registered lock-screen actions
  data:  { sid: sessionId, kind, origin }
}
```

**Badge ownership, amended post-review (2026-08-31):** the payload badge is a
SEND-time stamp for the firing user's count; while the app is foregrounded,
the ACTIVE instance's polled waiting count is the single writer of the icon
(the foreground presentation handler returns `shouldSetBadge: false` so a
push for another instance cannot outlive correction). "Badge equals the
waiting count" in the device gate therefore means *the active instance's*
count — the multi-instance registry postdates this sentence and a device
holding two instances shows one instance's truth on the icon.

No session name, no working directory, no notes, no operator text. The kind enum is
kept because "needs you" vs "crashed" is the difference between a glance and a
sprint, and it names nothing. This is also why the payload is **visible rather than
silent**: iOS best-effort-throttles `content-available` pushes and turns them into
lock-screen text only via a Notification Service Extension (custom native target). A
generic-but-instant notification needs no native extension, is reliable when the app
is killed, and leaks less than the web payload does today.

Detail is fetched, not pushed: the app opens `sid` with its own cookie session, so
the name only ever appears on a device that already authenticated.

**Delivery fan-out** stays inside `notifySession` (`services/notify.service.ts:98`).
The bell gate remains the single policy point above *both* transports, so flipping a
bell changes web and native identically on the next event — send-time, nothing to
invalidate.

The prune contract is mirrored, not invented. Web push prunes on a **rejection with
numeric `statusCode` 404/410** (the contract documented at `notify.service.ts:39-53`);
Expo's equivalent is a push ticket or receipt with
`details.error === "DeviceNotRegistered"`, which prunes. A `MessageTitleTooLong`-class
error is *our* bug and keeps the row; a transport exception is transient and keeps it.
Receipt polling for late-appearing unregister errors is deferred (§Follow-ups) — token
churn is bounded because enrollment upserts on every cold start.

**Device tokens rotate** (OS restore, app reinstall) and can change owner, so
enrollment is a transactional delete-then-insert scoped by user — exactly
`NotificationsRepository.upsertForUser`'s existing rationale.

## Backend diff

Auth and session lifecycle are untouched. This is the whole server-side change.

**Migration `0015-device-push-tokens.ts`** — created in
`apps/backend/src/db/migrations/` **and** registered in the static provider map in
`db/migrate.ts` (the boot migrator reads a static map because a dynamic import would
break `bun build --compile`); file name and map key must match. Style mirrors
`0014-session-notifications.ts`.

```
device_tokens
  id, user_id, token (unique), platform ('ios'|'android'), created_at, updated_at
```

Row type in `db/types/`, `DeviceTokensRepository` mirroring
`notifications.repository.ts` (`upsertForUser`, `listByUser`, `deleteByToken`).

**`services/expo-push.ts`** — `ExpoPushMessage`, ticket types, and an
`ExpoPushSender` function seam that tests fake, the sibling of `PushSender`.
Production sender: `expo-server-sdk` (7.2.0), chunked at 100.

**`api/devices.route.ts`** — `POST /api/devices {token, platform}` → upsert,
`DELETE /api/devices {token}` → idempotent removal. Cookie-only, mirroring
`browserOnly()` — but deliberately **not** gated on VAPID being configured: the Expo
transport is independent, and an instance with a broken `vapid.json` must still be
able to reach phones. Every `t` property carries a `description`; errors use the
`ApiErrorResponseSchema` body.

**`GET /api/sessions/summary` → `{total, running, waiting}`** — new
`api/sessions/summary-session.route.ts`, registered *before* `/:id` in
`api/sessions/index.ts`. No count endpoint exists today and the badge needs one both
for push payloads and for foreground refresh; `waiting` = `status='running' AND
alive=1 AND waiting_since IS NOT NULL`.

**Badge/waiting skew, stated rather than hidden.** `recordAttention` stamps
`waitingSince` *before* notifying (`sessions.service.ts:200-205`) while the idle
watcher notifies *then* stamps (`notify-idle.ts:122-126`). So a push-time badge is
`waiting + (kind ∈ {turn_complete, needs_attention} && row.waitingSince === null ? 1 : 0)`,
unit-tested — rather than reordering the watcher and disturbing its tested fire
contract.

## Security notes

- Token in SecureStore (Keychain), never in AsyncStorage; the instance registry
  (origins, labels, email) is non-secret and lives in AsyncStorage.
- `expo-local-authentication` gates **use** of the token, not its storage — biometric
  before attaching a socket or firing an action. This credential can inject
  keystrokes into every pane on the instance.
- Deep link `mote://session/<id>` carries a UUID only; opening it still requires the
  gate.
- Lock-screen content is generic by design (§Push), which incidentally means nothing
  sensitive is readable without unlocking.
- Plain-HTTP origins are allowed (a LAN is the supported deployment model) but the
  connection screen marks them, because the token then crosses the network in the
  clear.

## Screens

| Screen | Data | Actions |
| --- | --- | --- |
| **Connect** | user input; probe result | enter/paste origin; per-instance list (long-press delete) |
| **Sign in** | probe + `GET /api/setup/status` | email/password; "this instance needs setup" → points at the web wizard; rate-limit copy |
| **Sessions** | `GET /api/sessions` (polled), `GET /api/sessions/summary` | pull-to-refresh; sections Waiting / Running / Paused-exited / Completed mirroring the web grouping; card = name, harness, activity dot, `preview` via shared `stripAnsi`, amber waiting chip, `backoffCount`/`exitCode` on dead rows; tap → detail; tab badge = `waiting` |
| **Detail** | `GET /api/sessions/:id` | Live ∣ Log tabs; action bar rename / notes / bell / restart (revives in place, same id) / terminate / delete (confirm); status pill from the poll |
| **New session** | `GET /api/profiles`, `GET /api/setup/harnesses`, `GET /api/files/recent`, `GET /api/files/explore` | native folder sheet over `explore` (one level per request) with recents; profile picker; name; optional first prompt |
| **Settings** | instance registry, push permission, probe result | switch instance, re-probe, re-request notification permission, sign out (deregisters the device first) |

The key bar is the web table ported byte-for-byte from
`apps/frontend/src/components/terminal-key-bar.tsx:15-33` — `Esc ␛`, `^C ␃`,
`⇧Tab ␛[Z`, `Tab \t`, `⏎ \r`, `⇧⏎ ␛\r`, `/`, arrows as plain CSI (tmux translates;
SS3 not required) — plus press-repeat on arrows and a `⋯` page for `Ctrl-D/L/R` and
PgUp/PgDn. Paste is one `input` frame wrapped in `BRACKETED_PASTE_START/END`.

## Error handling

- **Probe, don't hang.** On save: sign-in → mint ws-token → open `/ws` with a ~3 s
  timeout. A close of 4001/4004 proves the upgrade reached the server (WS works);
  `onerror`/timeout with REST up means **WS blocked** — persisted per instance, a
  standing banner, Live tab hidden, one retry per 30 s. This is the exact shape of a
  proxy that forwards HTTP but not upgrades.
- **Restart is in-place.** `POST /:id/restart` revives the same row (same id,
  rotated token), so a deep link or notification opened after a restart still
  resolves to the live session. A 404 therefore only means deleted-elsewhere →
  route to the list. (Amended 2026-08-31 to match `53654a8`; the original text
  assumed the old mint-a-new-row contract.)
- 401 → clear token, preserve intended route, re-auth, resume.
- Every list/screen has distinct empty and error states (repo convention).
- Push is fire-and-forget from the backend's perspective: `notifySession` stays
  void-caught so a push outage can never stall liveness bookkeeping.

## Testing

Backend (`bun test`, per-process temp DB, never assuming an empty one; route tests via
`api/__tests__/helpers/auth-tables.ts`):

- `0015` migration: table + unique index + `down()`.
- `DeviceTokensRepository`: upsert moves ownership between users, unique token,
  delete paths.
- `api/devices`: cookie 200 + row owned; system-key bearer 403 + nothing stored;
  malformed token 400; anonymous 401; delete idempotent.
- `GET /api/sessions/summary`: count arithmetic across waiting/running/terminated.
- `expo-push`: bell gate off → no send; owner-only fan-out; `DeviceNotRegistered`
  prunes; transient keeps; badge formula including the watcher-order `+1`; >100-token
  chunking. **And one case constructing the service without the device transport, to
  pin the legacy web-push path — `notify.service.test.ts` itself must pass unmodified.**

Mobile: pure-logic unit tests only, no emulator — origin normalisation, the probe
classifier against a fake socket, cookie-name-by-scheme, token capture/rotation, the
poll policy state machine, section ordering (mirroring the tested
`lib/session-order.ts` predicate), and the key-bar byte table (mirroring the existing
frontend test).

Nothing mobile joins `turbo test`; the e2e suite's own `test:e2e` lane is the
precedent for a separate runner.

## Infra prerequisites (outside the app)

1. **Proxy WebSocket passthrough.** Phones reach
   `https://mote.ein.disaresta.com`, which today is HTTP-only with no upgrade
   tunnel (`netbird-proxy-mote`). Needed before the Live pane can be tested at all:
   forward `Upgrade`/`Connection`, raise the read timeout above the 600 s channel
   long-poll ceiling, `proxy_buffering off` if SSE is ever used. Everything except
   the Live tab works without it.
2. **Apple Developer account** for the iOS leg of Expo push, and **an FCM project +
   `google-services.json`** for the Android leg — without the latter Android push is
   silently dead rather than erroring.
3. **`EXPO_PUSH_ACCESS_TOKEN`** when proof-of-ownership is enforced; anonymous sends
   to exp.host are rate-limited.

## Verification

`bun run verify-types && bun run lint:check && bun run test` after every change (the
pre-push trio). Then, given the dev box is a headless Linux container with no root,
no JDK and no `/dev/kvm`:

- **In-container:** all backend suites above; and a **bun transport harness** against
  the now host-running instance that signs in, mints a ws-token, attaches `/ws`, and
  asserts a `replay` then `output` frames arrive — the entire auth+transport contract,
  provable with no device and no Xcode.
- **Android:** `expo export` for bundle integrity, then a local dev build from the
  separate JDK 17 + Android SDK container; APK sideloaded over wireless `adb`.
- **iOS:** `eas build --profile development` → TestFlight on the iPad.
- **Manual device gate** (mirrors the 08-30 spec's style): bell ON → agent finishes a
  turn → notification arrives with the app **killed** → title is generic, body has no
  session name → tap opens that session on the right instance → badge equals the
  waiting count → Silence bell from the lock screen works and Terminate is not
  offered → Face ID gate fires → iPad landscape shows three columns and Split View
  re-layouts.

## Invariants this design must not break

1. **No auth change.** `ws-token.route.ts:26` and `notifications.route.ts:41` stay
   exactly as written; the app conforms to them.
2. **Web push behaviour is untouched.** `buildNotificationPayload` and
   `notify.service.test.ts` pass unmodified — the new transport is additive.
3. **The terminal transport does not fork for mobile.** Same frames, same
   single-use-token rule, same close-code semantics, no second protocol.
4. **`stripSyncMarkers` stays server-side** (`session-ws.ts:132-139`); it is why
   keystroke→paint is 1-30 ms instead of ~1000 ms, and a client-side emulator must
   not reintroduce the cost.
5. **The narrow layout never writes `layout_json`** — the existing phone rule; a
   phone must not flatten a desktop split tree.
6. **Relayed push carries no session name, path, or operator text** — the one new
   privacy invariant this design introduces, and the thing to check first if a
   payload is ever extended.
7. `mote mcp`, harness plugins and the E2EE channel layer are untouched.

## Explicitly out of scope

- Workspaces, profiles CRUD, admin, users, audit — desktop.
- Channels: **no web UI exists today**, so a mobile channel view would be the first
  client of an unproven surface and needs client-side ECDH-ES+A256KW/A256GCM sealing
  (a third mirror of `apps/backend/src/mcp/crypto.ts` after the backend and `e2e/`).
  Not in v1.
- Structured transcript API — there is none, and inventing one is a bigger change
  than the WebView this spec already carries.
- True-native terminal rendering, widget, Live Activities, Siri/App Intents, Share
  Extension, offline mode, Android badge channels beyond the documented best-effort.
- Replying to a permission prompt from a notification — **no "answer the harness"
  endpoint exists**, so there is nothing for a rich-push action to call.
- Light mode (the product is dark-only by design).

## Follow-ups (noted during design)

- **`@xterm/headless` 6.0.0** — a DOM-free VT emulator, i.e. the path to a real
  native terminal (selectable, searchable, Dynamic Type, accessibility) *without*
  writing a parser. This is the right way to retire the WebView, not a rewrite of it.
- Gesture quick-actions (swipe restart/terminate, long-press menu) and the pinned
  prompt composer with recents — the two highest-value native-UI items after v1.
- Push **receipt polling** (`/push/getReceipts`) to catch unregister errors that only
  appear asynchronously.
- A Notification Service Extension for rich detail *and* a text-reply action — the
  latter gated on a future backend "answer the prompt" endpoint.
- Home-screen widget + App Intents for the waiting count against
  `GET /api/sessions/summary`; both need native modules.
- `GET /api/sessions/summary` should maybe carry muted counts, so widget copy can say
  "2 waiting · 1 muted".
- If SSE ever returns to mobile, re-examine single-use-token contention between the
  terminal and any background stream first — they must not race for one token.
