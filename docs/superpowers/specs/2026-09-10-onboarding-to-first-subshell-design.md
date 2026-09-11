# Design: Onboarding, from Download to First Subshell

Date: 2026-09-10
Status: approved design (brainstorm 2026-09-10), not yet implemented

The desktop app is the assumed entry point. Everything below is measured
against one user: someone who has just downloaded `Subshell Server` and has
never used this product.

## 1. The problem, measured

Eleven gates stand between that download and a running subshell.

| # | Gate | Surface |
|---|---|---|
| 1 | Pick the right release among four streams | GitHub |
| 2 | **tmux missing: every advancing button disabled** | console |
| 3 | Install server | console |
| 4 | **init form: Port, Bind address, Public base URL, Other addresses** | console |
| 5 | Install service, start | console |
| 6 | Open Dashboard | console |
| 7 | Account: Name, Email, Password, Confirm | wizard |
| 8 | **Harness not installed: copy a command, open a terminal, return, Re-check** | wizard |
| 9 | Finish setup, land on "No subshells yet" | wizard |
| 10 | Click "Create your first subshell" | empty state |
| 11 | **Node, Profile, Working directory (blank absolute path), Name** | `/new` |

Four of them cost users, and one of them is fatal.

**Gate 8 is fatal.** Every built-in plugin is `type: "agent-harness"` and every
one requires an external CLI. `PluginType` has a `"terminal"` member
(`plugin-api/src/types.ts:23`) and the `no-binary` detection reason is plumbed
through `plugin-adapter.ts:36`, `subshell-protocol/src/node-frames.ts:161`, the
node result validators and `harness-install-help.tsx`. **No plugin of that type
ships.** So there is no path to a running subshell on a clean machine, for
anyone, ever. Gate 8 is not friction, it is a hard requirement that the
onboarding flow never states.

**Gate 2** stops a GUI app on screen one and tells the user to open a terminal.
macOS ships no tmux, so this is most Mac users on first run.

**Gate 4** asks four infrastructure questions before the user has seen the
product work. Each already has a derived default, and `configure` exists as a
separate step reachable from `start`, `install-service` and `unreachable`. A
wrong `TRUSTED_ORIGINS` pays out later as `403 Invalid origin` at sign-in.

**Gate 9** ends the wizard one step short of the only event that proves the
product works.

**Gate 11** presents a blank absolute-path box. `useRecentPaths` returns nothing
by definition at first run, so `NewSubshellForm`'s pre-fill cannot fire.

## 2. The shape

The console stops being a setup flow and becomes a one-click installer plus a
repair panel. Onboarding lives in the SPA wizard, which is the surface that can
be designed. The two halves stay exactly as coupled as they are today: `main`
keeps its three granted commands, the console stays the only CLI driver.

After this change:

| | before | after |
|---|---|---|
| Screens to first subshell | 11 | 4 |
| Console interactions | 4 steps, 4 fields | 1 button |
| Mandatory terminal trips | up to 2 | 0, except macOS without Homebrew |
| Can a clean machine launch anything? | no | yes |

## 3. The `terminal` built-in

A new workspace package, `packages/plugins/terminal`, published as
`@subshell-ai/plugin-terminal`. Apache-2.0, like every other package outside
`apps/server/`.

### 3.1 It must declare a `detect` block

The obvious implementation, a plugin with no `detect`, does not work, and the
reason is worth recording because it reads like it should.

`no-binary` is wired through detection and display but **not** through
launching. Both inventories treat a null path as absent:

```ts
// pane-runtime/src/inventory.ts:42, and services/nodes/inventory.ts:216
if (found.path === null) return { harnessId: h.id, installed: false, reason: found.reason, checkedAt };
```

and the launch path refuses outright:

```ts
// subshell-manager.service.ts:297
const binary = await launcher.resolveBinary(harness);
if (!binary) throw new Error(`Harness "${harness.name}" is not installed on this machine.`);
```

A detect-less terminal plugin would therefore be invisible in every list and
unlaunchable from both the local and the remote path. Making it work would mean
special-casing a null binary in a hot path shared by `LocalLauncher` and
`RemoteLauncher`, for one plugin.

It does not need special-casing, because a shell **is** a binary:

```json
"subshell": {
  "apiVersion": 1,
  "id": "terminal",
  "type": "terminal",
  "name": "Terminal",
  "description": "A plain shell in a subshell pane. No agent, nothing to install.",
  "icon": "▸",
  "entry": "dist/index.js",
  "detect": { "binaryName": "bash", "envOverride": "SHELL", "knownPaths": [] }
}
```

Rung 1 of `detectBinaryWithOptions` reads `$SHELL`, confirms it is executable
and returns it, so this resolves to the user's real login shell and reports
`installed: true` with a version. Rung 2 finds `bash` on `PATH`. Rung 5 asks the
login shell. **No change to the launch pipeline, the inventories, or the usable
computation in `api/harness-utils.ts`.**

`knownPaths` stays empty deliberately, with a comment saying why:
`binary-lookup.ts:71` joins each entry against `$HOME`, so an absolute
`/bin/sh` would resolve to `$HOME/bin/sh` and silently never match.

No `install` block. `HarnessInstallHelp` renders the `no-binary` branch for a
plugin that declares no `detect`; this one declares one, so the ordinary
not-found path applies and reads correctly ("the bash command wasn't found") in
the genuinely broken case where `$SHELL` is unset and `bash` is absent.

### 3.2 Capabilities and command

`capabilities()` returns `[]`. A bare shell has no MCP dialect, no resumable
conversation, no attention signal to parse and no settings. Capabilities are
validated at load, so declaring none is the accurate statement and the launch
pipeline skips MCP generation. The host still injects the per-subshell
`SUBSHELL_*` environment, so a user who wants the MCP server can run
`subshell mcp` by hand inside the pane.

```ts
buildCommand: ({ binary, profile, extraFlags }) => [binary, ...profile.flags, ...(extraFlags ?? [])]
```

tmux supplies the PTY. A user who wants a login shell adds `-l` as a profile
flag. `validateProfile` delegates to `validateGenericProfile`.
`suggestedFlags` offers `-l`; `suggestedEnv` is empty.

Like every other plugin, identity lives in `package.json` and
`src/manifest.ts` re-exports it through `parseManifest` so the built-in and
on-disk reads are the same bytes.

### 3.3 Why this is the right thing to ship regardless of onboarding

It makes the whole product reachable without an agent: a terminal in the
browser that survives disconnect, tiles into workspaces, streams to a phone,
and can be shared read-only or read-write. That was always true of the
architecture and has never been usable on its own. Onboarding is the reason to
build it; it is not the only reason it earns its place.

Security posture is strictly narrower than any harness plugin, not wider: the
pane runs the user's own shell under the user's own account, which is what
every harness pane already does, minus the agent.

## 4. Built-in seeding gains a per-id record

`plugins-seed.ts` writes a `.seeded` marker and its presence stops every later
seed (`SEEDED_MARKER`, line 45). That rule exists for a good reason, recorded in
the file: an empty plugins directory is an operator who uninstalled everything,
and re-seeding on emptiness would undo that on every restart.

But it also means **an existing instance that upgrades never receives a newly
added built-in.** Today that has never mattered, because the built-in set has
never grown. This design grows it, so it matters now, and only fresh installs
would get `terminal`.

The marker becomes a record of *which ids* have been seeded rather than a
boolean that a seed happened:

- `.seeded` holds a JSON array of built-in ids this store has ever seeded.
- A seed pass installs only built-ins whose id is absent from that list, then
  appends them.
- An id present in the list is never re-installed, so an uninstall still sticks
  permanently. That is the property the original marker protects and it is
  preserved exactly.
- A legacy `.seeded` file with non-JSON content (the current empty marker)
  reads as "every built-in that existed before this change", which is the five
  agent harnesses, hardcoded as a migration constant. A pre-existing instance
  therefore gains `terminal` and nothing else, and an operator who had
  uninstalled `codex` does not get it back.

Written after the pass completes, as now, so an interrupted first seed is still
retried.

### 4.1 Existing users get a Terminal profile for free, and the ordering is why

A plugin in the store that a user has no profile for cannot be launched, so a
seeded `terminal` would otherwise appear in the picker with nothing to pick.
Nothing new is needed, because boot already does it in the right order:

```
index.ts:123   await prepareLocalPlugins();            // seeds built-ins
index.ts:145   await ensureDefaultProfilesEverywhere(db);  // every real user × every instance harness
```

`ensureDefaultProfiles` walks `instanceHarnessIds()` against `realUserIds(db)`
and inserts only missing pairs, so the same boot that first seeds `terminal`
also gives every existing user a blank Default for it. New users are covered
separately by `ensureDefaultProfilesForUser` on registration (`auth.ts:99`).

**That ordering is load-bearing and currently incidental.** Seeding after the
backfill would leave every existing user with a Terminal they cannot launch
until the next restart. A comment at both call sites should say so, since
nothing else in the file explains why 123 precedes 145.

## 5. The console: one consented click

`probe.next` already computes the whole sequence: `install-server`, `init`,
`install-service`, `start`, `ready`. Every step in that chain has a correct
default and asks the user nothing they can answer on day one. The console
currently spends four clicks and four form fields executing a plan it has
already made.

**The `install-server` / `init` / `install-service` / `start` chain collapses
into one step, `setup`,** with one button and an explicit list of what pressing
it does:

> **Set up Subshell on this machine**
> - Install the bundled server to `~/.local/bin/subshell-server`
> - Write `~/.config/subshell-server/config.env` (port 3080, all interfaces)
> - Register it to start at login (systemd user unit / launchd agent)
> - Start it and open the dashboard
>
> [ Set up and start ]   [ Change addresses… ]

Installing a binary and registering a background service is not something to do
unasked, so this is one **informed** click rather than zero clicks. The
disclosure is what makes collapsing four steps honest.

The chain then runs unattended, reporting each sub-step into the existing
command-output pane, and ends by invoking `openMain`.

**`setup` replaces exactly one probe state: `install-server`.** The other steps
are unchanged and still render for the state that produced them, because each
describes a machine that is already part-way through and needs a specific act,
not a fresh run:

| `probe.next` | before | after |
|---|---|---|
| `install-server` | step 1 of 4 | **`setup`**, the one-click chain |
| `init` | form, 4 fields | unchanged, reached only when config is genuinely absent on an already-installed server |
| `install-service`, `start` | own steps | unchanged |
| `ready`, `unreachable`, `no-server` | own steps | unchanged |

**Nothing is removed from the console's repair surface.** `configure`,
`pickBinary`, `unreachable`, `no-server`, `ready` and its Restart/Stop actions
all stay. `configure` is the escape hatch, reachable from the setup screen
before the run and from `ready` after it.

If any sub-step fails the run stops there, the console renders the CLI's own
words verbatim (as it does now), and the step machine falls back to the precise
step for the state the machine is actually in. A half-run leaves the user where
today's flow would have left them, never worse.

## 6. Installing what is missing

### 6.1 tmux

No bundling. A static tmux would mean a musl toolchain in
`docker/desktop-builder.Dockerfile`, which per root `AGENTS.md` moves the image
tag and strands roughly 2 GB of layers on every runner that pulled it, on a
fleet where `runner-maintenance.yml` already fails past 85% disk. It would also
mean a bundled terminfo directory, a second sidecar in the macOS notarize path,
and a CVE cadence for a C dependency that nothing in this repo currently owns.

Instead, the setup screen runs the platform's own installer when tmux is
missing, as the first item in the same consented list:

- **macOS:** `brew install tmux`.
- **Linux:** the first of `apt-get`, `dnf`, `pacman`, `zypper` that resolves,
  run through `pkexec` so the user gets their desktop's password prompt rather
  than a silent failure.

**The macOS-without-Homebrew case is the one this does not solve, and it gets a
real answer rather than a dead button.** When `brew` does not resolve, the
screen says so, offers the MacPorts command as an alternative, links to
`https://formulae.brew.sh/formula/tmux`, and keeps today's copy-to-clipboard
affordance. The existing behaviour where the warning self-clears on the next
poll is preserved, so installing tmux in a terminal still unblocks the app with
no further action.

### 6.2 Agent CLIs

All five built-in install commands are `curl -fsSL … | sh` into the user's home
and need no elevation. The setup screen offers **one** of them, Claude Code, as
an optional checked-by-default item, with a line saying it can be skipped and
added later. The `ready` step keeps a permanent "Install an agent CLI…"
affordance so this is reachable after setup.

**Only built-in plugins may be auto-run this way.** A third-party plugin's
`install.command` renders as copy-to-clipboard, exactly as today. The narrow
reasoning: an installed third-party plugin already executes arbitrary code in
the control-plane process, so running its install string adds no capability
*there*, but the console is a different process in the user's desktop session,
and creating a second execution path with different trust properties is not
worth it for a case nobody has asked for.

**Remote nodes are out of scope.** Installing a harness on an enrolled node
would need a signed command and a new node verb. Node pages keep today's
copy-command guidance.

### 6.3 Where the installer lives, and why not in the SPA

The SPA cannot execute anything on the host, and giving it the ability would
mean either a new server endpoint that runs install strings, or a fourth Tauri
command granted to the `main` window. Both widen a boundary
`apps/server/desktop/AGENTS.md` draws deliberately: `main` is scoped by
`capabilities/main.json` to three commands that cannot touch the CLI, the
config, the service or the filesystem, and an XSS in the SPA reaches those
three and nothing else.

So the installer lives entirely in the console, before the dashboard opens,
which is also the moment the user has already consented to installs. The
wizard's harness step reports what is present and never needs to execute
anything. **No new API surface, no new granted command, no posture change.**

## 7. The wizard ends in a running subshell

`apps/server/web/src/routes/setup.tsx` goes from two steps to three.

**Step 1, Account: unchanged.** Name, email, password, confirm password, the
same `authClient.signUp.email` call. Auth is the one place friction is arguably
load-bearing, and this is where the admin credential is established.

**Step 2, Harness: becomes skippable.** The step keeps its `HarnessRow` list
and gains an honest primary action. Because `terminal` is always usable, this
step can no longer dead-end, so:

- The heading becomes "Add an agent (optional)".
- The copy states the fallback plainly: a subshell can run a plain terminal, and
  an agent can be added any time from Settings.
- The existing "register a Node" escape hatch stays, because it is still the
  right answer for someone whose agents live on another machine.
- `Finish setup` becomes `Continue`.

**Step 3, Launch: new, and it is the point of the whole design.**

One `NewSubshellForm`, reused whole, with `ids` scoped to the wizard, plus a
single primary button reading `Start my first subshell`. On success it navigates
to `/subshells/$id`, so the wizard's last action lands the user in a live
terminal rather than on an empty state.

Defaults, which are what make this one click:

- **Node:** `local`, already the `emptyNewSubshellForm` default.
- **Profile:** the Default profile of the first *usable* agent harness if one
  exists, else Terminal's. Enabling a harness already seeds a blank Default
  profile, so this is always resolvable. Preferring an agent over Terminal
  matters: a user who did install Claude Code should get Claude Code.
- **Working directory:** see §8.

The step still renders the full form, so every field is visible and changeable.
The defaults mean it can be submitted without touching any of them.

A create failure renders through the existing `createSubshellErrorMessage`,
which already speaks `NODE_OFFLINE` and `harness_disabled`. The step also gains
a `Skip for now` link to `/`, because a launch that cannot succeed on this
machine must not trap the user in the wizard. `finish()` keeps its existing
`setQueryData(["setup-status"], { needsSetup: false })` call on both paths, for
the reason already recorded there.

## 8. Launch defaults

These apply to `NewSubshellForm` everywhere, not only in the wizard, and they
are the reason step 3 is one click rather than one typed path.

**Working directory.** `useRecentPaths` is empty on a fresh instance, so the
existing pre-fill cannot fire and the field falls back to a placeholder reading
`/home/you/my-project`. The pre-fill ladder becomes:

1. The most recent path for the selected node (today's behaviour, unchanged).
2. Failing that, the node's home directory.

Home is not currently reported. `GET /api/files/recent` is the natural carrier
since it is already node-scoped and already fetched by this form: it gains a
`home` field beside `paths`. The node side already reports `homeDir` on `ready`
(see the plugins-on-the-control-plane spec §5), so the remote case needs no new
round trip.

The existing guard stays exactly as it is: applied once per mount, and only
while the field is empty, so it never fights typed input or the caller's state.

**Profile.** When no profile is selected and profiles have loaded, select the
first non-disabled option. `buildProfileOptions` already computes the disabled
set against the chosen node, so this cannot select something that will not run.
It slots into the one existing correction effect rather than adding a second,
for the reason that effect was consolidated.

## 9. What this does not change

Recorded because a reader will wonder.

- **The auth posture.** First registered user is still the admin, still a real
  credential, still `better-auth`. No Tauri command mints a session, no account
  is auto-provisioned.
- **`main`'s capability set.** Still the three commands in
  `capabilities/main.json`.
- **Plugin install authority.** `/api/plugins` writes stay cookie-admin.
  Installing an agent *CLI* through the console is not installing a *plugin*.
- **The vocabulary.** `terminal` is a `PluginType` that already exists. It names
  a kind of plugin, not a machine and not an interface, so it collides with
  nothing in the server/node/client scheme.
- **The licence split.** Every new package sits outside `apps/server/`, so all
  of it is Apache-2.0 and `lint:licenses` needs no new `PERMITTED_CROSSINGS`
  entry.

## 10. A bug this surfaces

`harness-install-help.tsx` derives the override variable name from the binary:

```ts
function envOverrideName(binary: string): string {
  return `${binary.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PATH`;
}
```

Every built-in happens to follow `<BINARY>_PATH`, so this has always been right
by coincidence. `terminal` is the first plugin whose `envOverride` is not that
shape: a broken `$SHELL` would produce a message naming `BASH_PATH`, a variable
the user does not have set and changing it would not help.

`envOverride` is already in the manifest. `HarnessInfo` gains the field,
`harnessInfo()` in `api/harness-utils.ts` populates it from the manifest, and
`HarnessInstallHelp` reads it instead of deriving it. `envOverrideName` is
deleted rather than kept as a fallback: a fallback here is a wrong answer that
looks like a right one.

## 11. Error handling

| Failure | Behaviour |
|---|---|
| tmux install refused or unavailable | Setup run stops before touching the machine. Screen states it, offers alternatives, keeps copy-to-clipboard. Next poll re-checks and unblocks on its own. |
| A setup sub-step fails | Run stops there. CLI's own words verbatim in the output pane. Step machine falls back to the state the machine is actually in. |
| Agent CLI install fails | Non-fatal, never blocks setup. Reported, and the run continues to the dashboard. Terminal is still launchable. |
| Wizard step 3 create fails | `createSubshellErrorMessage` as today. `Skip for now` always available. |
| `$SHELL` set but not executable | `override-invalid`, and after §10 the message names `SHELL` correctly. |
| Neither `$SHELL` nor `bash` resolves | Terminal reports `not-on-path` like any other harness. Genuinely broken machine; nothing to paper over. |

## 12. Testing

**`packages/plugins/terminal`** gets the same shape every plugin has: a manifest
parse test, a `buildCommand` test, a capabilities test asserting `[]`, and a
test that `knownPaths` is empty with the `$HOME`-join reason named in it.

**Detection** gets a test that `envOverride: "SHELL"` resolves through rung 1,
and one that an unset `$SHELL` falls through to `bash` on `PATH`.

**Seeding** gets the cases that matter: a virgin store seeds all six; a store
with a legacy empty `.seeded` gains only `terminal`; a store that seeded all six
and then had one uninstalled does not get it back; an interrupted pass retries.

**The wizard** gets a page test that step 3 renders with a submittable form
given a seeded profile, that `Skip for now` leaves the wizard, and that
`needsSetup` is retired on both exits.

**`NewSubshellForm`** gets pre-fill tests for the home fallback, that a recent
path still wins over home, and that neither overwrites typed input.

**The console's pure half** gets tests for the collapsed step and for the
platform-to-installer mapping, including the no-Homebrew branch.

**e2e** gains one spec that is the whole point of this document: from a fresh
instance, complete the wizard without installing any agent CLI, and assert a
live terminal. If that spec passes, a clean machine can reach a running
subshell, which is the claim the current build cannot make.

## 13. Out of scope

- Installing a harness on a **remote node**. Needs a signed command and a node
  verb; node pages keep copy-command guidance.
- Auto-running **third-party** plugin install commands.
- Any change to the account step.
- Bundling tmux.
- `apps/client/desktop`'s own first run. It has the same shape of problem and
  deserves the same treatment, but it is a separate flow with a separate window
  model and it should get its own pass.
