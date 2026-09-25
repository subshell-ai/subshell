# The loopback dashboard: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## The loopback dashboard (`src/dashboard/`, spec 2026-09-19)

`subshell run` binds **127.0.0.1:3090** and serves the node its own admin
page (Status, Node Settings, Updates) under the control plane's verbatim
`/api/nodes/:id/*` contract, so the cards in `@internal/node-admin` run
untouched against either backend. The contract is the whole design: a route
that drifts from the plane's shape is a card that renders wrong on one side,
and `dashboard/__tests__/dashboard.test.ts` pins the shared shapes precisely
so that cannot go unnoticed.

- **Started from `cli.ts`'s `case "run"`, not from `runDaemon`**; the
  log-hygiene rule again (`apps/node/agent/docs/logging.md`): `daemon.test.ts` calls `runDaemon` directly and
  must not bind ports. `SUBSHELL_DASHBOARD=0` opts out,
  `--dashboard-port`/`SUBSHELL_DASHBOARD_PORT` (flag wins) move it. A busy
  port costs the dashboard and never the daemon: every bind failure is one
  warn line and a node that runs anyway. The plane socket is this process's
  first job.
- **No login; the listen address IS the access control** (accounting:
  `docs/security.md` §6, "The node's loopback dashboard"). `guards.ts`
  refuses a non-loopback `Host` (DNS rebinding), a non-loopback `Origin`
  when one is present, and any mutation that is not `application/json`
  (forces the preflight the Origin rule can defend). No cookie is ever set.
- **The guard's placement is load-bearing and was measured, not assumed**:
  Elysia lifecycle hooks are definition-ordered and do NOT cross an instance
  boundary: a guard on the outer app that `.use()`s `buildRoutes` guards
  the SPA fallback but NOT the API routes (the copy carries its own
  lifecycle), and the mirror composition guarded the routes but not the
  fallback; three live smokes each found one of the halves. So `buildRoutes`
  registers `onBeforeHandle` FIRST on its own instance, and `server.ts`'s
  fallback calls the exported `guardResponse` explicitly. A wire test
  refuses a foreign Host on both kinds of path over a real socket.
- **`app.server.port` is the real port** (`:0` resolves through it);
  Elysia's `listen()` promise resolves with the app instance, NOT a Bun
  serve handle, so the cast that read `{port}` off the resolution found
  none. And listen must be AWAITED: the sync form throws EADDRINUSE through
  `cli.ts`'s catch and killed the daemon on a busy port, exactly the
  failure the fail-soft rule exists to forbid.
- **Mutations reuse the command executors**, narrowed to what they read
  (`ServiceExecContext`, `UpdateExecContext`): the supervision and
  pane-safety refusals, the maintenance kill order, and the signed-update
  verification are ONE implementation shared with the plane-driven path.
  During the daemon's boot window (or after a failed boot-time service read)
  the frozen runtime report is null while the MANAGER did start this pid:
  the update route re-proves that with one live query and threads the answer
  into `execUpdate` as its `supervisedProof` (round-3 review, finding 5), so
  the null the page just disproven cannot 409 the supervised node a handler
  later. A caller with NO proof (the plane-commanded path) keeps the null-
  runtime refusal verbatim, and a present frozen report always outranks a
  proof: supervision cannot change while the pid does not.
  `maintenance on` here KILLS local panes, the node's own CLI semantics
  (flag first, kill, re-probe), not the plane's no-kill version, because
  the local card has no race to win. The version refusals ("already at",
  downgrade) belong to `applyUpdate`; no route re-implements them.
- **Restart/update exit only through the daemon** (`dashboard/state.ts`
  bridges `ctx.requestRestart`), keeping the result-before-exit discipline;
  `runtime` on the view is the daemon's FROZEN report so the page shows
  exactly what the plane is shown. With no daemon (a future standalone
  verb) `liveRuntime()` memoizes 5 s rather than spawning per poll.
- **Pages: disk → embedded → notice** (`web-static.ts`, the server's
  static plugin ported: AGPL source, this app Apache, the `log-file.ts`
  deliberate-copy precedent stated in the file). `scripts/embed-web.ts` +
  the TRACKED stub `generated/embedded-web.ts` + the release pipeline's
  preflight/embed/finally-restore mirror `release:cli-server` exactly; a
  `cli-node-v*` binary carries the dashboard, a dev binary serves
  `apps/node/web/dist` or the honest no-dashboard notice.
