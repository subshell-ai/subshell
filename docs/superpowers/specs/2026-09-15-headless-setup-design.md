# Headless setup: the CLI carries the sequence the assistants carry

**Date:** 2026-09-15
**Status:** approved

## 1. What this is about

Both desktop apps are sequencers wrapped around a CLI. Subshell Server's
assistant runs `install → init → service install → start` from one button and
hands off to the SPA's `/setup`. Subshell Client's node window runs
`install agent → enroll → service install` screen by screen, gates every step on
tmux, and confirms anything destructive.

A headless operator gets the same verbs with **no sequence and no handoff**.
Every mechanism this needs already exists. Nothing points at it.

That is the whole defect, and it is why the fix is mostly sequencing and
sentences rather than new capability.

## 2. The gaps, measured

### 2.1 Server (`subshell-server`)

| Gap | Where it is today |
|---|---|
| **Nothing says "open this URL and create the admin account"** | Not `init`, not `configure` (`commands/configure.ts:637` ends "restart the server … to apply"), not `service install`'s success line (`service.ts:507-512`), not the boot log (`server.ts:54-55` prints the URL and nothing about it), not `status`. Spec 2026-09-11 §6.4 promised `/setup` to "a CLI-provisioned server's first visitor" — nothing ever sends them there. |
| **The first-run window is a race nobody is told about** | `/api/setup/*` is public until the first user exists (`api/setup.route.ts:124`). A headless box on a LAN is briefly registerable by anyone. |
| **No way to get the binary** | No server `/install.sh`, no `GET /api/downloads/server/*`. `README.md:239-247` is `gh release download` plus a hand-paired shasum. |
| **Browser `/setup` has no tmux step** | The tmux screen is native-only. A headless install learns tmux is missing when the first launch fails, or in Settings → Status. |
| **`init --yes` / non-TTY silently takes `0.0.0.0` with no `TRUSTED_ORIGINS`** | The first LAN sign-in dies on 403 "Invalid origin". The two existing `applyConfig` warnings cover remote nodes and a port mismatch, not this. |
| **Linger scrolls away** | Printed once at `service install` (`service.ts:506-512`). `service status` does not report it. The browser's `PersistenceFacts` has it, but you must already be signed in. |
| **Update, reset, supervision are desktop-only** | `update-card.tsx:26` returns null in a browser: a headless install is never told a newer server exists. |
| **The agent-CLI installer has one entrance** | `POST /api/setup/agents/:id/install` is called from exactly one place (`routes/setup.tsx:64`). Skip step 2 and there is no path back. |

### 2.2 Node (`subshell`)

| Gap | Where it is today |
|---|---|
| **`install.sh` ends at a foreground daemon** | `api/install-script.ts:187-190`: `./subshell` in the curl CWD, then "start the agent with: `./subshell run`". `run` dies with the SSH session. `enroll` says the same (`node/agent/src/cli.ts:435`). Neither names `service install`. |
| **`README.md:201-204` is false** | It claims the one-liner "can install itself as a background service". `grep service` on the rendered script returns nothing. |
| **tmux is never mentioned before it matters** | Not in `install.sh`, not in the Add-node dialog. `enroll` refuses correctly (`enroll.ts:123`) but on a piped terminal. |
| **The dialog's guidance ends at enrollment** | "Close this dialog to see it in the list." (`add-node-dialog.tsx:193-197`). |

### 2.3 Facts that shape the fix

- The repo is **public**; raw files fetch anonymously. So a one-liner is
  hostable from `raw.githubusercontent.com` with no server in the loop.
- **No releases or `server-v*`/`node-v*` tags exist yet.** The install script
  can be written and tested against a fake release host now, and goes live with
  the first cut.
- Spec 2026-09-11 §11 named "moving the setup chain into the CLI" a non-goal of
  **that** pass, on the grounds that the first act copies the app's own sidecar.
  That reasoning is about the desktop app's first act, not about a headless
  install, which has no sidecar to copy. This spec reverses the non-goal
  deliberately and says so rather than letting the two documents disagree
  quietly.

## 3. Design

### 3.1 Principles

1. **The CLI owns the questions; the scripts own the download.** Each shell
   script downloads, verifies, installs the binary, reattaches stdin to the
   terminal, and invokes ONE CLI verb. All prompting lives in TypeScript behind
   the existing `prompt` deps seam, so tests inject answers and nothing has to
   parse a shell prompt.
2. **One rule for `--yes`**: every question takes its default; the service
   question's default is yes. A non-TTY without `--yes` behaves the same way.
   `--no-service` is the opt-out — for scripts, and for the desktop apps, which
   install the service themselves with their own autostart choice.
3. **The handoff is said where the operator is standing**: at the end of the
   command that started the server, in the boot log, and in `status`.
4. **Browser surfaces reuse what exists**: `persistence()`, `useAdminStatus`,
   `useInstallAgent`/`AgentRow`, `chooseTmuxInstaller`, `applyConfig` warnings.
   The only new server-side computation is the tmux install route and one
   boot-time user count.

### 3.2 Why a prompt library

`readSync(0, …)` renders one line and cannot show a default, a validation
error, or a cancel. The service question is the first real branch a headless
operator meets, and it deserves the same "here is the default, press enter"
affordance the assistant's radio buttons give. `@clack/prompts` (1.8.1) is
pinned into both CLIs behind the existing deps seam, so the production
implementation changes and every test keeps injecting a plain function.

Two constraints it must not break: it prints nothing under `--json` or a
non-TTY, and it survives `bun build --compile` in both binaries.

## 4. Phase 1 — the terminal path carries the sequence

### 4.1 `init` becomes the setup sequence

After `runConfigure` succeeds, `runInit` asks one question — "Run Subshell
Server in the background and start it at login?", default yes — and on yes calls
the same `installService` that `service install` calls. Then it prints the
handoff: `Open <APP_BASE_URL>/setup in a browser to create the admin account.`
`service install` prints the same line when run alone, because that is the other
command a person ends on.

When `HOST` is `0.0.0.0` and the base URL is loopback, a second line names
`http://<hostname>:<port>` and the `--trusted-origins` flag, because that is the
address they will actually browse from and the one that 403s.

**The desktop app passes `--no-service`** (`control.rs` `init_args`): it installs
the service itself, with its own autostart checkbox, and a question inside `init`
would ask something the assistant already answered.

### 4.2 A third `applyConfig` warning

LAN bind + loopback base URL + empty `TRUSTED_ORIGINS` is the exact
configuration whose only symptom is a 403 naming nothing. The warning goes in
the shared validator, so the CLI, the desktop assistant and the dashboard's
Addresses card all inherit it — that sharing is why there is one implementation
to change rather than three.

### 4.3 The boot log and `status` say whether an account exists

Boot counts users after migrations; zero logs the `/setup` line. `status` gains
a `setup` field: database missing, present-with-no-users (naming the URL), or
present-with-users. `status` is documented as "the first thing to run when
something looks wrong" and today it cannot answer the first question a stuck
operator has.

### 4.4 `install-server.sh`

At the repo root, fetched from raw.githubusercontent. Resolves the triple
(refusing Intel Mac by name), resolves the newest `server-v*` release, downloads
the binary and its `.sha256`, **verifies before the first `chmod +x`**, installs
to `~/.local/bin/subshell-server`, warns when that is not on PATH, warns when
tmux is absent, reattaches `/dev/tty` when there is one, and runs `init`.

The digest check before `chmod +x` is the same rule the node script follows and
is what makes a piped install sound.

### 4.5 `subshell setup`

One node verb that is the whole enrollment: tmux preflight, enroll, ask about
the service (default yes), install it, then say `This machine is a node. Open
<server>/nodes to see it.` `enroll` stays a primitive for anyone composing their
own flow; its closing line stops recommending `run` first and names
`service install` instead. So does `status`'s OFFLINE line.

`install.sh` installs to `~/.local/bin/subshell` — the same path the desktop
client writes, so a later `service install` bakes a definition pointing
somewhere stable rather than at whatever directory the curl ran in — checks tmux
before downloading, and invokes `setup`.

## 5. Phase 2 — the browser meets the headless operator

### 5.1 A tmux row on `/setup` step 2

Detection-first, above the agent list, from the admin status the page can
already read. Found is a green fact. Absent shows the platform's command, and an
**Install** button only where the installer needs no privilege — brew on macOS.
Linux installers are `sudo apt-get`/`sudo dnf`, and the server has no terminal to
answer a password prompt, so there the command is copyable and nothing more.

Continue is never blocked. The launch step refuses honestly on its own, and a
wizard that traps someone behind a package manager is worse than one that told
them what is missing.

### 5.2 "Finish setting up" on Settings → General

A card composed client-side from facts three existing endpoints already return:
tmux missing, supervision/linger (through `persistence()`), LAN sign-in refused,
placeholder auth secret, no agent CLI on this host. Admin-only, renders nothing
when there is nothing left, no dismiss state — a checklist you can silence is a
checklist that lies.

It is deliberately not a new endpoint. Every item is a fact some page already
shows; what is missing is one place that says which of them still need doing.

### 5.3 The agent installer gets a second entrance

The `local` node's harness card gains **Install on this server** for admins,
reusing the same route and the same streaming UI. This is the fix for
"skip step 2 and there is no way back".

### 5.4 The Add-node dialog says what the command does

One paragraph before the one-liner: tmux is needed, the command installs to
`~/.local/bin`, enrolls, and asks about a background service. The success line
links to the node's own page, where detection has run, instead of ending at
"close this dialog".

## 6. Security accounting

**The tmux install route** (`POST /api/setup/tmux/install`) runs a package
manager as the server's own user. It is the same class as the agent-CLI install
accounted in `docs/security.md` §11.10, and narrower in every dimension:

- **Admin cookie only**, never public — unlike the rest of `/api/setup`, which
  is public during the no-users window. It is a write that runs code, so it
  follows the agent installer's gate, not its neighbours'.
- **Fixed argv from `chooseTmuxInstaller`**, with no operator input reaching the
  command line at all. The agent installer at least takes a plugin id; this
  takes nothing.
- **Refuses anything `sudo`-prefixed** (409), so the route can only ever run an
  unprivileged installer. That is what keeps "the server installs tmux" from
  meaning "the server escalates".

Everything else in this spec is sentences, sequencing, and one client-side
composition of facts already on screen. No new credential, no new reader of
anything, no widening of who may do what.

Two disclosures worth naming even though neither is new:

- **`status` gains a `setup` line** that says whether an admin account exists.
  It reads the local database as the local user, who can already read the file.
- **`install-server.sh` is fetched over the public internet** and piped to a
  shell, exactly as the node one-liner already is. The digest check before
  `chmod +x` is what bounds it, and the script verifies before it executes
  anything.

## 7. Deferred, named so nobody infers them

- **A headless update signal.** The server asking GitHub for the newest
  `server-v*`, `/api/admin/status` carrying it, and `UpdateCard` showing a
  copyable re-run of the install script in a browser. Needs a release to exist
  before it can be tested honestly.
- **A node `uninstall`/reset verb.** The client's native reset is
  "approved-and-unbuilt" (spec 2026-09-12 §6.5); a CLI verb should be designed
  with it, not ahead of it.
- **Linger and maintenance in the desktop client.** `ipc.ts`'s
  `ServiceStatusBody` carries no `linger`, so the app a person is sitting at
  shows only "starts at login" — the label `supervision.ts` calls a trap.
- **A CLI-driven e2e** (`init` → `service install` → `/setup`). Spec 15 boots
  with env vars and bypasses `config.env` entirely.
- **The Docker path's greyed Restart.** `restart.available` requires the manager
  to report this pid; a container can never satisfy it. Document it, do not
  fix it.
- **The tmux offer's second prompt seam.** `init` and `configure` now prompt
  through `@clack/prompts`, but the tmux offer keeps a synchronous seam, so its
  one y/n renders as a text box rather than a confirm. Its preflight is shared
  with `installService`, which returns a `CliResult` rather than a promise and
  cannot await, so unifying them means making every service caller async — a
  real ripple for a cosmetic gain. Worth doing deliberately or not at all; half
  of it is worse than neither.

## 8. Testing

- `applyConfig`'s third warning, `status`'s `setup` field, `init`'s service
  question and its `--no-service` opt-out, and the node `setup` verb: unit tests
  beside each, injecting the prompt seam.
- `install-server.sh`: a Bun test spinning a fake release API and artifact host,
  asserting verify-before-chmod, the install path, refusal on a digest mismatch,
  the Intel refusal, and `--no-service` forwarding.
- `downloads-route.test.ts`'s install.sh assertions move from `./subshell` and
  the `run` line to the new destination and the `setup` invocation.
- The tmux route: admin-only, 409 on a `sudo` installer and on an unknown
  platform, detection re-probed after the run.
- `setup-checklist.ts` is a pure function and is tested as one.
- e2e 01 asserts the tmux row renders.

## 9. Two things measured while building this

- **`status` cannot open the database read-only and stop there.** SQLite cannot
  read a WAL database without a writable `-shm` beside it, and a read-only
  connection may not create one — so on any instance whose sidecars are gone (a
  restored backup, a cleanly closed copy) the open succeeds and the first query
  throws. The count falls back to read-write with `create: false`, which still
  never creates a database. A test deletes the sidecars to pin it.
- **A test that used the production service deps installed a real launchd
  agent.** It wrote into the operator's own `~/Library/LaunchAgents` with
  `ExecStart` naming a test file; launchd bootstrapped it and respawned it ten
  times against the operator's real database. Stubbing the harness fixes the
  harness, so the guard went at the production filesystem seam instead:
  `DEFAULT_DEPS` refuses to write or remove a service definition outside the OS
  temp directory while `NODE_ENV=test`, in both the server and the node agent.
  It is deliberately NOT a check on `home` — tests that stub `writeFile` pass a
  fake home and never touch a disk, and refusing those buys nothing.
