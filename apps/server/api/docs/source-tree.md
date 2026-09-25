# The src/ tree with its full original comments. Moved verbatim from AGENTS.md ("Architecture"); AGENTS.md keeps a shortened tree and routes here.

```
src/
├── api/            # Routes: flat *.route.ts (incl. downloads.route.ts — the subshell binaries; admin-status.route.ts — the whole instance in one admin-only read; plugins.route.ts — /api/plugins, the instance plugin store, writes cookie-admin) + per-resource dirs (subshells/, workspaces/, channels/, nodes/, users/, auth-providers/) + auth-guard.ts + routes.ts; install-script.ts renders root-mounted GET /install.sh
├── auth/           # Api-key store, DB handle, system user, the sign-in providers (provider-policy.ts, provider-guards.ts, provider-rows.ts, oidc-discovery.ts; better-auth config: ../auth.ts)
├── db/             # Kysely setup, migrations (static provider map), types/, repositories/
├── lib/            # context.ts (ApiContext + getRequestlessContext), api-error.ts (apiErrorBody)
├── plugins/        # auth.plugin.ts (better-auth handler mount), context.plugin.ts, error-handler.plugin.ts, static.plugin.ts
├── schema/         # Shared response schemas (error.type.ts: ApiErrorResponseSchema)
├── scripts/        # e2e seed, embed-web.ts (SPA -> generated/embedded-web.ts), release.ts
├── services/       # Business logic: subshell-manager, nodes/ (NodeLauncher seam), channels/, uploads, tokens, audit, notify, mcp-launch — tmux/ no longer lives here: TmuxRunner moved to `@internal/pane-runtime` (tmux-runner.ts) so the node CLI can reuse it
├── utils/          # Logger and small shared helpers
├── ws/             # Terminal attach WebSocket (short-lived single-use tokens — cookie-minted ones unscoped, Bearer-minted ones bound to one subshell at issue and refused elsewhere or on /ws/live; remote-node subshells relay through remote-subshell-ws.ts with the browser contract byte-identical to the local path) + the dashboard's live feed (spec 2026-09-19): live-ws.ts (one socket per tab, snapshot at connect, previews answered on request), live-topics.ts (the recipient set, derived row->viewers and diffed against resolveSubshellAccess by an exhaustive test) and live-publisher.ts (bus events -> Bun pub/sub broadcasts, coalesced per id). It replaced the /api/events SSE stream, which held one of the browser's six per-origin HTTP/1.1 connections per tab
└── test-preload.ts # Loaded by bunfig.toml before every test run
```
