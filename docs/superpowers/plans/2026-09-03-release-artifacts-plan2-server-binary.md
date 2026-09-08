# Release Artifacts — Plan 2: subshell-server Single Binary + CLI

> **For agentic workers:** implement task-by-task, TDD where code is new. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship `subshell-server` as one self-contained binary (embedded SPA) with first-run ergonomics (`version`/`init`/`configure`/`service`/`status`) and a bytecode release pipeline, per spec §3–§5.

**Architecture:** Generator script bakes `apps/frontend/dist` into a static TS module; `static.plugin.ts` gains a memory mode with disk precedence. A `config.env` loader (0600, `process.env`-setdefault semantics) runs as the first import of the boot path. CLI dispatch at the top of `index.ts` keeps the no-subcommand boot byte-identical (svc.sh contract). Release script clones the client's proven shape with a `SERVER_TARGETS` triple set.

**Tech Stack:** Bun 1.4.0, Elysia, biome, `bun test`.

## Global Constraints

- Precedence: **process env > config.env > `.env`-via-dotenvx(existing) > built-in defaults.** config.env must NEVER overwrite an already-set `process.env` key.
- `config.env` lives at `<serverConfigDir>/config.env` where `serverConfigDir = process.env.SUBSHELL_SERVER_CONFIG_DIR ?? ~/.config/subshell-server` (new override var for tests). Mode **0600**, written tmp+rename. `BETTER_AUTH_SECRET` is generated once and carried forward verbatim by `configure`.
- **tmux preflight** in `init` and `service install` (the `local` node launches panes through it): warn+refuse with platform hint (`brew install tmux` macOS / `apt install tmux` Linux); escape hatch `SUBSHELL_SERVER_SKIP_TMUX_CHECK=1` (mirrors client).
- Non-interactive everywhere: `init`/`configure` accept `--port --host --base-url --db-path --yes`; non-TTY implies `--yes`.
- No dynamic imports. CLI parsing hand-rolled (client `cli.ts` pattern). Compiled entry stays `src/index.ts` (tsc `dist/index.js` boot path must not change).
- Binary/artifact names: `subshell-server-<triple>`; server triples `linux-x64 linux-arm64 darwin-arm64` (`SERVER_TARGETS` in protocol `paths.ts`, barrel-safe; `serverArtifactFileName()` beside `nodeArtifactFileName`). Dev `compile` script outputs `apps/server/dist/subshell-server` (was `dist/backend`).
- Embedded SPA: generator OUTSIDE the runtime import graph like client's `release.ts`; emitted module `apps/server/src/generated/embedded-web.ts` is gitignored; static import inside `static.plugin.ts` must resolve even when the file is a committed stub regenerated at release time — ship the stub as a tracked placeholder that re-exports an empty map + `EMBEDDED=false` flag (boot falls back to disk/no-embedded error path when unregenerated).
- Every subagent task ends green on: focused tests → `bun run verify-types` → `bun run lint:check` → `bun run test` (root).
- Commit per task, Conventional Commits. Branch `feat/plan2-server-binary` cut from current `main`.

---

### Task A: embed generator + static-plugin memory mode

**Files:** Create `apps/server/src/scripts/embed-web.ts` (import.meta.main-guarded, pure exports: `collectDist(distDir) → Record<relPath, base64>`, `emitModule(map) → string`); Create tracked stub `apps/server/src/generated/embedded-web.ts` (`EMBEDDED_WEB: Record<string,string> = {}`, `EMBEDDED = false`); Modify `apps/server/src/plugins/static.plugin.ts` (accept `{ dir } | "embedded"`-style second param — keep the exported `staticPlugin(root: string)` signature working for server.ts; add `embeddedPlugin()` factory or a mode arg); Modify `apps/server/src/server.ts` (choose disk-if-exists else embedded, both-missing → today's loud error extended); `.gitignore` += `apps/server/src/generated/embedded-web.ts`? NO — the stub is tracked, the generator OVERWRITES it; keep the path OUT of gitignore and let releases commit nothing (generated file changes stay uncommitted working-tree noise? Untracked-noise would dirty `git status`). Resolution: generator writes to `src/generated/embedded-web.ts` AND that path is gitignored; the TRACKED fallback lives at `src/generated/embedded-web.stub.ts` and is COPIED to the real name by whoever needs it (postinstall? no — static import needs the file present at typecheck/clone time). FINAL DESIGN: tracked `embedded-web.ts` stub committed; generator overwrites it; `.gitignore` NOT used; release scripts run generator before compile and `git checkout -- apps/server/src/generated/embedded-web.ts` after publish (documented in-script). Tests: generator round-trip (fake dist incl. binary asset), emitModule contains EMBEDDED=true + index.html key, missing index.html → throw; plugin memory mode: `/` + `/index.html`, `/assets/*` content-type + immutable cache + ETag, SPA fallback, traversal guard, disk-precedence.

### Task B: config-env loader + CLI dispatch + version

**Files:** Create `apps/server/src/config-env.ts` (`serverConfigDir()`, `configEnvPath()`, `loadConfigEnv()` parses KEY=VALUE lines ignoring comments/quotes, setdefault semantics, silent no-op missing file, throws on unreadable file); Create `apps/server/src/cli.ts` (`dispatchCli(argv): Promise<boolean>` — no known subcommand → false → boot proceeds; handles `version` (package.json import), `status` placeholder prints resolved config w/ masked secret, liveness note); Modify `apps/server/src/index.ts` — FIRST import `./config-env.js` side-effect, call dispatch before boot side-effects (careful: `assertProdAuthSecret()` and process handlers run at module eval — dispatch must run BEFORE them: place dispatch + a `process.exit` on handled inside the FIRST imported module chain: pattern — cli module itself does `if handled exit`; index.ts imports `./cli-bootstrap.js` first whose top-level await dispatches). Tests: config-env setdefault/precedence/comment/quote parsing; cli version/status.

### Task C: init + configure (interactive & --yes)

**Files:** Create `apps/server/src/commands/configure.ts` (`runConfigure(deps)` DI'd prompt fn; questions: port(3080), host(127.0.0.1 / 0.0.0.0 choice), base-url(default http://localhost:<port>, loopback warning note), db-path(default <configDir>/subshell.db); rewrites config.env preserving BETTER_AUTH_SECRET; validates port 1-65535 + URL parse; tmp+rename 0600) + `commands/init.ts` (mkdir configDir, generate 48-char base64url secret if absent, then invoke configure flow); wire into cli.ts (`init`, `configure`); `--` flags + `--yes`; non-TTY→yes. Tests with injected prompts; carry-forward test; --yes defaults test; flag override test; secret NOT regenerated test. tmux preflight warn here (deps-injected existsSync).

### Task D: server service.ts (systemd + launchd)

Mirror `apps/client/src/service.ts` DI pattern: unit `subshell-server.service` (ExecStart = the running executable path; `Environment=HOST/PORT` from config.env is auto since EnvironmentFile = config.env!; WorkingDirectory = configDir parent? unit must set `EnvironmentFile=<configDir>/config.env`, `Restart=unless-styled`→ use `unless-stopped`; PATH baked like client) and launchd `dev.subshell.server` plist (KeepAlive, log `~/Library/Logs/subshell-server.log`). `service install|uninstall` in cli.ts; refuses without config.env and without tmux (unless skip var); launchd bootout of old label not needed (new label). Tests pin unit/plist text + command sequences.

### Task E: release pipeline + compile rename

protocol: add `SERVER_TARGETS` + `serverArtifactFileName()` to paths.ts (+barrel exports + tests). server: `apps/server/src/scripts/release.ts` cloned from client release.ts (entry `./src/index.ts`, outfile `subshell-server-<t>`, ALWAYS `--bytecode --minify --target`, floor guard 1.4.0, `SUBSHELL_SERVER_RELEASE_TRIPLES` scope env, embed preflight: require frontend dist + run embed generator before build and restore stub after; local publish dir `SUBSHELL_SERVER_RELEASE_DIR ?? <repo>/dist-server`). Root `release:server` script; `compile` script → `dist/subshell-server`. Tests mirror client release suite.

### Task F: docs + merge

apps/server/AGENTS.md new "Standalone binary & CLI" section; root AGENTS.md publish dance gains release:server; spec §7 CI notes gain runner labels; CHANGELOG Unreleased note. Merge plan branch to main, push (authorized).

---

### Plan 3 (separate doc when A–F land)

.changeset (config.json: ignore everything except @internal/server + @internal/client, changelog-github), release.yml: `release` job (changesets/action) on push main [self-hosted, Linux, X64]; `build` matrix per §7 with labels [self-hosted, Linux, X64] (linux-x64 native + linux-arm64 cross) and [self-hosted, macOS, ARM64] (darwin targets, Rosetta smoke for x64); `publish` draft→flip via gh. Tag + release the CURRENT versions directly via workflow_dispatch (first cut: server-v1.0.0, client-v0.1.0) — version PRs govern later bumps. Then Mac deploy (plan doc §"MAC").
