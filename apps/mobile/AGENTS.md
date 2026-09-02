# Mobile AGENTS.md

Native companion app for mote: phones and tablets, built with React Native +
Expo SDK 57. Design:
[`docs/superpowers/specs/2026-08-31-mobile-native-app-design.md`](../../docs/superpowers/specs/2026-08-31-mobile-native-app-design.md).

It is not a second web app. Its reason to exist is the four things a web page
cannot do: background push, app-icon badge, lock-screen actions, and a
Keychain-held credential behind Face ID. Session *viewing* on a phone is
already served by the responsive web shell — do not re-ship it here.

## Commands

```bash
bun run start          # Metro (run from the app dir; see "No dev script")
bun run verify-types   # tsc --noEmit
bun run test           # bun test — pure logic only, no emulator
bun run build          # expo export (JS bundle only — see below)
```

Requires the host toolchain file: `. ~/.config/mote-mobile-env.sh`
(JDK 17, Node, Android SDK). New shells source it automatically from `~/.bashrc`.

## Non-obvious decisions

**`build` never touches a native toolchain.** Root `turbo run build` and CI must
keep working on a machine with no Xcode. `build` is `expo export` (JS bundle
integrity check → `dist/`); real binaries are `eas build` (iOS) and
`expo run:android` / a dev build (Android), both outside the turbo graph.

**No `dev` script, on purpose.** Root `bun run start` is `turbo watch dev`;
adding `dev` here would silently start Metro for everyone who runs it. Use
`bun run --cwd apps/mobile start`.

**Node is a runtime, not a package manager.** `.claude/rules/package-manager.md`
still governs: `bun install`, `bunx`, never npm. Node exists because Metro, the
`expo` CLI and `eas` are Node programs. `npx expo install <pkg>` is the one
exception — it delegates to the workspace's own client and is the only
dependable way to get SDK-57-compatible versions.

**Versions: Expo's picks, pinned exactly, no syncpack exemption.** Use
`npx expo install <pkg>` — it resolves the version SDK 57 is built for, which
is often *not* npm's latest (`react-native-webview` is 13.16.1 here, npm offers
14.x; `@shopify/flash-list` 2.0.2 vs 2.3.2). It writes `~` ranges, so follow
every install with `bunx syncpack fix && bun install`.

**⚠️ `bunx syncpack fix` is repo-wide and will edit the *other* apps.** Adding
`@tanstack/react-query@5.102.8` here caused it to bump
`apps/frontend/package.json` from 5.101.4 to match. Either pin the new dep to the
version the web app already uses (what this app does now — 5.101.4), or
`git checkout` the collateral file. Never commit a drive-by dependency bump to
`@internal/frontend` from mobile work.

Two things were verified rather than assumed, and both were luckier than
expected: the repo's `react@19.2.8` satisfies RN 0.86's `^19.2.3` (Expo did not
downgrade it), and **`typescript@7.0.2` typechecks the whole Expo/RN surface
cleanly** — so no `versionGroups` carve-out was needed. If a future SDK bump
breaks that, add the exemption in `syncpack.config.js`; do not loosen the
exact-pin rule.

`npx expo install --check` will keep reporting `react` and `typescript` as
"outdated". That is expected and currently harmless — both are JS-side, and the
native build works at the repo's pins. Don't "fix" them by guessing; the real
constraint is the one below.

**⚠️ Never let a `*` peer resolve freely.** `expo-router` declares
`react-native-reanimated: "*"`, so bun installed reanimated 4.6.0, which needs
`react-native-worklets@0.12.x` — and 0.12 removed
`WorkletRuntime::executeSync`, which `expo-modules-core@57.0.14` still calls
(its peer range is `^0.7.4 || … || ^0.10.0`). The Android build died in C++:
`error: no member named 'executeSync' in 'worklets::WorkletRuntime'`. The fix is
to pin both through Expo's resolver, and they are explicit dependencies now:
`react-native-reanimated@4.5.1` + `react-native-worklets@0.10.1`. After changing
either, delete the stale native caches or the old include path is reused:
`find node_modules/.bun -type d -name .cxx -path '*expo-modules-core*' -exec rm -rf {} +`.

**TypeScript extends `@internal/tsconfig`, not `expo/tsconfig.base`.** Repo
consistency won; the few RN-specific options (`jsx`, `lib`, `types`) are set
inline in `tsconfig.json`.

**`@/` alias needs both halves**: `paths` in `tsconfig.json` (for `tsc`) and
`experiments.tsconfigPaths` in `app.json` (for Metro). Change one, the other
goes red at runtime rather than at typecheck.

**`assets/terminal.html` is generated — never hand-edit, never lint.** The
Live tab's xterm page (JS + CSS inlined, zero network requests — the WebView
owns no network and cannot reach the token) is produced by
`bun scripts/sync-terminal-assets.ts` (from `apps/mobile`), which re-inlines
the pinned `@xterm/*` files from `node_modules`. After bumping either dep,
re-run it and commit the regenerated file. The root `biome.json` excludes
`**/assets/terminal.html` — the exclusion is cwd-agnostic on purpose, because
the pre-commit `lint:staged` task runs biome from `apps/mobile` and a
path-anchored pattern silently stopped matching there.

**SDK 57 no longer bundles `@expo/vector-icons` through `expo`.** Without an
explicit dependency the bottom-tab default glyphs render as tofu boxes in any
custom dev build (Expo Go masks this). `@expo/vector-icons@15.1.1` is an
explicit dep and `(tabs)/_layout.tsx` passes `tabBarIcon` per screen.

**SecureStore key slug**: `mote.token.<origin with [^A-Za-z0-9._-] → _>`
(`src/native/secure-token-store.ts`). Keychain names forbid most URL
characters, so the slug is lossy-but-stable; never key tokens by the raw
origin.

**If `npx expo install` dies on this host's TLS flakiness**, the fallback is
`bun info <pkg> dist-tags` + `bun add <pkg>@<exact SDK-57 version>` (bun
honours an exact specifier and writes no range). Afterwards verify with
`git status` that no other app's `package.json` moved.

## Auth

The app authenticates as the **better-auth cookie actor**, not a bearer client:
`POST /api/auth/sign-in/email` → session token → `expo-secure-store` → sent
as a `Cookie` header. Do not "modernise" this to a system API key:
`api/ws-token.route.ts` and `api/notifications.route.ts` reject bearer actors
*deliberately*, and being the cookie actor is what lets the app attach a
terminal and enroll for push without any backend auth change.

**Store the token from `Set-Cookie`, never the response body.** better-auth
1.7.x signs its session cookie (`"<token>.<sig>"`, ~85 chars); the 32-char
token in the JSON body is the *unsigned* one and 401s on every guarded route.
Proven live by the M1 transport harness (`bun run harness:m1`): body-token →
401, Set-Cookie-token → 200. `MoteClient.signIn` keeps the body value only as
a no-cookie fallback. This whole flow is exactly what the harness exists to
falsify — run it against a scratch instance after any auth-transport change.

## Layout

```
app/         # expo-router routes — thin: URL state + composition only
src/
├── lib/      # api/transport, breakpoints, tokens (non-UI)
├── hooks/    # TanStack Query hooks
├── components/
└── types/    # hand-written mirrors of API response shapes
```

Same rule as the frontend: route files stay thin, data logic goes in `hooks/`,
shared helpers in `lib/`, tests co-located in `__tests__/`. No dynamic imports
anywhere in this repo.

The launch-node picker (`(tabs)/new.tsx` + `src/hooks/use-nodes.ts`, with the
pinned-profile re-anchor decision in `src/lib/node-anchor.ts`) is the mobile
mirror of the web `new-session-form.tsx` of the same shape — change one, change
both. On the wire `local` is OMITTED from the create body (the server default),
keeping single-machine payloads byte-identical to pre-nodes ones.

## Verifying on Android

**Use the `*_34` AVDs: `mote_tablet34` (1280×800dp — the only place the wide
shell appears besides iPad landscape) and `mote_phone34` (Pixel 9).** The API 37
image (rev 6) is unusable headless: surfaceflinger aborts in a loop with
`Assertion failed: !rcEnc->featureInfo()->hasReadColorBufferDma…` in
`RegionSamplingThread`, taking system_server and the launcher with it — an
upstream emulator bug in host colour-buffer readback, hit with both
`swiftshader_indirect` and `swangle`. API 34 is rev 14 and boots clean in ~12s
with zero errors.

```bash
emulator -avd mote_tablet34 -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -memory 4096 -no-snapshot-save &
adb wait-for-device
adb reverse tcp:8081 tcp:8081    # the app reaches Metro through this
```

Health check is functional, not by property: **`init.svc.system_server` is empty
even when the framework is fine** — use `adb shell pm list packages | grep -c .`
and `adb logcat -b crash -d | grep -c 'F DEBUG'`.

Because `expo-dev-client` is installed, launching `MainActivity` opens the **dev
launcher**, not the app: type `http://localhost:8081` into its field and tap
Connect (dismiss the soft keyboard first, or the tap lands on the keyboard).
A `pm clear` drops the remembered server, but mDNS usually re-displays the
Metro card a moment later — one tap beats typing.

**The flaky `mqt_v_js` SIGSEGV seen at cold start is not (yet) attributable
to app code.** Observed on API 34 x86_64 debug builds: `SEGV_ACCERR` on the
JS thread seconds after `Running "main" … "fabric":true`, ~119 native frames,
no JS output yet — so it dies inside engine startup, not inside our modules.
It is intermittent: the same APK cold-booted again reaches the app. A web
search for an upstream tracker entry did not surface a matching issue, so no
reference is given here (one research pass produced fabricated issue
numbers — deleted; verify before citing). Practical stance: relaunch before
debugging, and reproduce on a real device / release variant before blaming
the app.

Driving the UI over adb has three traps, all hit for real: `input text` drops
the first characters if it fires immediately after `input tap` (sleep ~1-2 s);
`keyevent 66` (Enter) does not advance focus between RN `TextInput`s — use
`keyevent 61` (Tab); and a mis-timed tap can type the password into the email
field, so verify with a screenshot before submitting. Reset a stuck sign-in
with `adb shell pm clear nu.suteki.mote` instead of fighting the fields.

For a throwaway backend to sign into, reuse `e2e/stack.ts` (`startStack` —
fresh temp DB on :3199, PI stub harness) with `adb reverse tcp:3199 tcp:3199`;
do not point the app at the live :3080 instance, and never reset a real
account's password to get test credentials.

A real device is still required for the things an emulator lies about: soft
keyboard behaviour, push delivery, badge counts, lock-screen actions.

**Push cannot be end-to-end tested from this repo as-is.** A bare
`expo run:android` dev build carries no `google-services.json` (verified in
logcat: `Default FirebaseApp failed to initialize … google-services was not
applied`), so `getExpoPushTokenAsync` throws and `enrollPush` no-ops — no
token ever reaches the backend, so nothing can ring. Before any push/badge
device test: `eas login` + `eas init` (writes `projectId`/`owner` to
`app.json`) + `eas credentials` → download `google-services.json` → set
`android.googleServicesFile` in `app.json`, then rebuild the dev client.
The wire format itself was verified against exp.host with fake-token
probes (typed-field validation is at ticket time; unknown keys tolerated).

**Hardware GL on this dev host is not available headless.** `-gpu host` fails
`Failed to get EGL display` because GLES host mode needs a display-backed
context; headless Vulkan does reach the RTX 5080, so ANGLE (`-gpu host -angle`)
is the only route, and software rendering is fine for layout work — it also
keeps the two RTX PRO 6000s clear for the LLMs. Never bind a second X server to
the output the desktop is scanning out from: it takes DRM master and the
compositor keeps running blind.
