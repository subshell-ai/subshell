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

**TypeScript extends `@internal/tsconfig`, not `expo/tsconfig.base`.** Repo
consistency won; the few RN-specific options (`jsx`, `lib`, `types`) are set
inline in `tsconfig.json`.

**`@/` alias needs both halves**: `paths` in `tsconfig.json` (for `tsc`) and
`experiments.tsconfigPaths` in `app.json` (for Metro). Change one, the other
goes red at runtime rather than at typecheck.

## Auth

The app authenticates as the **better-auth cookie actor**, not a bearer client:
`POST /api/auth/sign-in/email` → session token from the response body →
`expo-secure-store` → sent as a `Cookie` header. Do not "modernise" this to a
system API key: `api/ws-token.route.ts` and `api/notifications.route.ts` reject
bearer actors *deliberately*, and being the cookie actor is what lets the app
attach a terminal and enroll for push without any backend auth change.

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

## Verifying on Android

Two AVDs exist on the dev host: `mote_phone` (Pixel 9) and `mote_tablet`
(medium tablet — the wide shell only appears here and on iPad landscape).
Headless: `emulator -avd mote_tablet -no-window -gpu swiftshader_indirect
-no-audio -no-boot-anim`.

A real device is still required for the things an emulator lies about: soft
keyboard behaviour, push delivery, badge counts, lock-screen actions.
