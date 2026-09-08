# Harness notifications: push when a session waits for you

Date: 2026-08-30 · Status: approved design, pre-implementation

## Problem

When a harness session finishes a turn, hits a permission prompt, or dies, the
only way to notice is to be looking at the tab. The operator wants a phone or
desktop notification at those moments, and clicking it should land directly on
the session. Because mote serves several users, each person decides per
session whether it is worth ringing them — default is silent.

## Decisions (from the design conversation)

- Delivery: **Web Push** (service worker + VAPID), not in-tab Notification API
  (dies with the tab) and not an external relay (ntfy/Telegram would leak
  session names to a third party — against the instance's self-contained posture).
- Events: turn complete, needs approval, session exited/crashed.
- Cross-harness: all harnesses get what they can; the design is two-tier
  (native hooks where the harness has them, a universal idle heuristic where not).
- Policy: **per-session bell toggle in the ⋯ menu, default OFF** — no per-user
  event-kind settings. The Settings page only turns push on/off per device
  (plumbing), never decides which sessions ring (policy).
- List treatment: every "waiting for you" session gets an amber chip; bell-on
  waiting sessions sort to the top of the running group. Chip on all is
  visibility (free), the bell controls push noise.
- iPhone: Web Push exists there only for a Home-Screen-installed PWA; the UI
  says so. Android/desktop Chrome & Firefox push from the normal site.

## Architecture

```
Backend                                        Frontend
─────────────────────────────────────────────  ─────────────────────────────────────────
db 0014: sessions.notify, sessions.waiting_since
db 0014: notifications_subscriptions table     public/sw.js  (service worker, site root)
api/notifications.route.ts   subscribe/unsubscribe/config
api/sessions/:id/attention   harness hook sink (session-key, self-scoped)
api/sessions/:id/notify      bell toggle       components/session-actions-menu.tsx (bell item)
services/notify.service.ts   the fan-out bus   lib/notifications.ts  (subscribe glue)
services/notify-idle.ts      quiet-output watcher (3 s tick)
                                              lib/session-order.ts  (chip + sort helper)
                                              Settings → Notifications card
```

### Event sources

1. **Claude Code hooks (native, precise).** Mote already owns the `--settings`
   JSON handed to every claude pane. It injects `Stop` (turn finished) and
   `Notification` (permission prompt / waiting for input) hooks whose command
   is a fire-and-forget `curl POST $MOTE_BASE_URL/api/sessions/$MOTE_SESSION_ID/attention`
   with `Authorization: Bearer $MOTE_API_KEY` (all three env vars are already
   baked into the pane). Hooks merge into the profile's settings object
   (`{...profile.settings, hooks}`) — a profile that sets its own `hooks` key
   is overridden; mote's signal wins (documented in the injection site).
2. **Idle watcher (universal, heuristic).** For sessions whose harness
   declares no native hook (opencode, hermes, pi — capability flag on the
   plugin): a ~3 s tick alongside the 60 s reconcile stats each alive
   session's pipe-pane log; mtime quiet ≥ 20 s → "turn complete".
   Edge-triggered: fires once per idle transition; any output re-arms it.
   Backend boot initializes state from current mtimes (no idle-spam for
   sessions that were already idle). Sessions whose harness has native hooks
   never FIRE the idle event (Claude's hook is earlier and precise — no
   double-notify, no cooldown heuristic needed), but the watcher still stats
   every alive session — it is the single place that CLEARS `waiting_since`
   on output-resume, uniformly for all harnesses.
3. **Exit/crash (universal).** `reconcileRows` already discovers pane death
   for every harness; it gains a notify call. `restart_on_exit` rows say
   "crashed — auto-restarting", all others "exited". Death also clears
   `waiting_since`. *Errata (final review): once the auto-restart backoff is
   exhausted (the same `backoffCount >= 5` limit the sweep gives up at) the
   kind is `crashed_final` and the body is the bare "Crashed" — a row that
   will never restart must not be announced with a restart promise.
   Backend-internal only: the `/attention` body union stays
   `turn_complete | needs_attention`.*

### Waiting state (`waiting_since`)

- Set when an attention/turn-complete event fires (from either source) while
  the row is alive.
- Cleared when output resumes (the idle watcher's mtime check clears it for
  all harnesses uniformly) or the session exits. *Errata (live verification):
  clearing carries an 8 s settle grace after the stamp — Claude's Stop hook
  fires while the TUI is still flushing its turn-ending redraw, so growth
  immediately after a hook-set stamp is the same turn's tail, not the
  operator replying; without the grace the chip was cleared by its own turn
  within one tick.*
- Exposed as `SessionView.waitingSince`; rides the existing 1.5 s SSE feed, so
  open tabs update with no new transport.

### Delivery

`notifyService.notifySession(sessionId, kind)`:

1. Load the row; **return unless `notify = 1`** (send-time gate — flipping the
   bell takes effect on the next event with nothing to invalidate).
2. Look up the **owner's** subscriptions (never another user's).
3. Web-push each with payload `{title, body, url: "/sessions/<id>", tag: <sessionId>}`.
   The `tag` replaces a session's older notification instead of stacking.
4. Endpoint `404/410` → delete the subscription row; other errors keep it and
   log once (transient).

VAPID keys: generated on first boot into `/data/vapid.json`, reused after;
unwritable directory → the feature reports "not configured on this instance"
and subscribe endpoints 503 — the server never crash-boots over push.

Library: `web-push` (pinned, per the prefer-libraries rule).

### Service worker (`public/sw.js`, same-origin at site root)

- `push` → if a *focused* client is already showing that session's route,
  stay silent (you're looking at it); else show the notification.
- `notificationclick` → focus an existing mote tab (or open one) and navigate
  to `/sessions/<id>`; close the notification.
- Payload/title-building and the focused-tab suppression decision live in a
  pure module (`lib/sw-logic.ts`-style) so bun tests cover them without a
  browser.

### API surface (auth)

- `GET  /api/notifications/config` → `{publicKey}` — cookie-only.
- `POST /api/notifications/subscribe` → stores `{endpoint, keys}` for the
  cookie user, upserting on endpoint. Cookie-only.
- `POST /api/notifications/unsubscribe` (same body) — cookie-only.
  (Machine keys 403 everywhere here: subscribing a device is a
  human-in-browser act, matching the files-route stance.)
- `POST /api/sessions/:id/attention` — **session-key actor only, self-scoped**
  (`principal === sess:<id>`, same guard as `/name` and `/notes`); body
  `{kind: "turn_complete" | "needs_attention"}`; 403 for foreign bearer or
  cookie actors, 400 unknown kind.
- `PATCH /api/sessions/:id/notify` — `{notify: boolean}`; cookie or the
  session's own key (self-scoped), owner-scoped otherwise. Mirrors the
  rename-route test shape.

### Database (migration 0014, registered in the migrate.ts map)

- `sessions.notify` integer NOT NULL DEFAULT 0.
- `sessions.waiting_since` text NULL.
- `notifications_subscriptions`: `id` (uuid), `user_id`, `endpoint` (text,
  unique), `p256dh`, `auth`, `created_at`.
- Existing rows: `notify = 0` — the default-silent policy the operator asked
  for, including sessions that are running right now.

### UI

- **⋯ menu:** bell item between Pin and Terminate — "Notify when done" ↔
  "Mute notifications" (`Bell`/`BellOff`), immediate (non-destructive).
- **Home list/cards + workspace session lists:** amber "Waiting for you" chip
  when `waitingSince`; within the running group order = bell-on & waiting
  first, everything else exactly as today. Shared pure helper
  `lib/session-order.ts`, unit-tested, applied by the views — not forked
  per-route.
- **Settings → Notifications card:** enable/disable push for this browser.
  States: *Off*, *On for this browser*, *Blocked* (permission denied — show
  the OS-level hint). On iOS Safari (no SW/push in a normal tab) show a
  one-time "Add to Home Screen, then enable there" note.
- Notification body examples: "resume-verify — done, waiting for you" /
  "resume-verify — needs your approval" / "resume-verify — exited".

## Error handling

- Push send: prune dead endpoints on 404/410; transient failures keep the row
  and log once. Notify calls from the reconcile sweep are void-caught — a push
  outage can never stall liveness bookkeeping.
- Hook curl failures are silently swallowed by Claude (hooks are non-fatal by
  design); a lost event only costs one notification — the idle heuristic and
  the chip still work.
- Idle watcher: stat failures treat the session as not-armed; it never throws
  into the sweep.
- Subscribe with a malformed/expired endpoint → 400; duplicate endpoint across
  users: the unique endpoint row wins for the new subscriber (a re-authorized
  browser legitimately moves).

## Testing

- `0014` migration test: both columns + subscriptions table, defaults, down().
- `notify.service`: bell gate (off → no send), owner-only fan-out, 410-prune,
  404-prune, transient-keep.
- `/attention` route: self bearer 200, foreign bearer 403, cookie actor 403,
  unknown kind 400; sets `waiting_since`.
- `PATCH /notify` route: toggle both directions, self-scope bearer guard
  (rename-route pattern).
- Idle watcher: fire once per transition, re-arm on output, set/clear
  `waiting_since`, boot-state init, native-hook harnesses skipped
  (injected clock + fake log files).
- Reconcile: exited → notify call + waiting cleared (extend live tests).
- Frontend: `session-order` (chip predicate + sort), bell menu item
  (mutation + invalidate), `lib/notifications` subscribe flow (mocked fetch;
  blocked permission path), `sw` pure logic (payload build, focused-tab
  suppression).
- E2E: none — Playwright cannot assert browser-level push delivery; route +
  component coverage carries the feature.

## Verification

`bun run verify-types && bun run lint:check && bun run test`, then deploy and
prove in the real browser: enable push on desktop Chrome, bell ON, ask Claude
something with a pause, walk the tab to the background → OS notification
arrives → click lands on the session. Phone check via NetBird → Home-Screen
PWA (iOS) or Chrome (Android) as available.

## Explicitly out of scope

- Per-event-kind user settings (the single bell is the policy, by decision).
- Push for other users' sessions, admin fan-out, or harness-initiated
  arbitrary notification text (payloads are built from session data
  server-side; the hook body carries only an enum kind).
- iOS in-tab notifications (impossible; PWA path documented instead).
- Badge counts, notification actions beyond click.

## Follow-ups (noted during design)

- Opencode can later gain a Tier-1 signal (its config layer supports a plugin
  on session.idle) — the capability flag makes that additive, no redesign.
- The reconcile/`lastOutputAt` machinery and the idle watcher both stat pane
  logs; if sweeps ever get expensive they can share one pass.
