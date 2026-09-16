# Network plugins, phases 2 and 3: Headscale, NetBird, Cloudflare Tunnel

**Date:** 2026-09-16
**Status:** approved, three plugins buildable in parallel
**Amends:** `2026-09-15-network-plugins-design.md` § 4.5 (vendor table), § 8, § 10

## 1. What this adds

Phase 1 shipped the `type: "network"` contract, the `/api/network` routes, the
supervisor, the Access guard, and Tailscale as the one plugin. This spec turns
the vendor table at § 4.5 into three more packages. The master spec § 4.5 is
the authority on every argv, field name, and state mapping; THIS file decides
only what § 4.5 leaves open, and everything a plugin builder must not break.

The three are independent work: one package directory each, one shared file
touched each (`packages/pane-runtime/src/registry.ts`, its own import and its
own list entry). Nothing here waits on anything there.

## 2. Rules every one of the three inherits

These are load-bearing from the master spec and security-context, repeated
because three different builders are working at once:

- **The plugin describes, the host executes.** No spawning, no file writes, no
  config.env, no reading a credential back — `host.secrets` has no `get`.
  Every effect is a `PluginHost` member or returned data.
- **The sudo boundary is absolute.** No `install.command` starting `sudo`;
  privileged steps are manifest data, printed to copy.
- **A URL a plugin reports is http(s) or it is not rendered** — the
  `isDocsUrl` rule at parse time and the gate's runtime drop.
- **Platform support is manifest DATA**; the card must be able to answer
  "not on this OS" without loading plugin code.
- **Every `host.run` argv[0] comes back absolute from `host.findBinary`.**
- **Built-ins are imported STATICALLY** (the compiled binary must see them);
  register in `packages/pane-runtime/src/registry.ts` beside `tailscale`.
- **`detect.knownPaths`:** HOME-relative, or absolute when starting with `/`
  (rule landed 2026-09-16 with the Tailscale app route).

## 3. The npm bootstrap is NOT done — plan for it

A new `@subshell-ai/*` package is inert until a human hand-publishes `0.0.1`
and configures the trusted publisher (AGENTS, "Everything after that comes
from CI"). Until that happens for these three:

- `package.json` carries `"version": "0.1.0"` (the tailscale precedent) and
  the package IS ADDED to `.changeset/config.json`'s `ignore` list.
- A plugin's own changeset is therefore NEVER written — its user-visible
  description belongs in the **`@internal/server`** changeset of the PR that
  lands it.
- The bootstrap procedure (hand-publish 0.0.1 → `npm trust github` → remove
  the ignore entry LAST, never earlier) is recorded in memory
  [[network-plugins-phase-1]]; it is an operator step, not agent work.

## 4. Plugin 1 — `headscale`

Same binary as tailscale, different control server (§ 8). Decisions § 4.5
leaves open, decided here:

- **Package:** `packages/plugins/headscale`, `@subshell-ai/plugin-headscale`,
  id `headscale`, name "Headscale". Description: "Reach this server over your
  own self-hosted tailnet."
- **Reuse, not fork:** import NOTHING at runtime, so "inlining the shared
  source" (spec § 4.5) is done by tsdown `noExternal` — the headscale package
  imports the TAILSCALE source files at BUILD time only if
  `@subshell-ai/plugin-tailscale` is a devDependency and tsdown inlines it.
  Do NOT add a runtime dependency; do NOT import a bare specifier of ours
  (plugins cannot resolve one). If inlining the tailscale module graph turns
  out to fight the build (it reads its OWN manifest today), the sanctioned
  fallback is: copy the needed source into the headscale package with a
  comment naming where it came from, and pin the shared argv constants with a
  containment test (the `tmux-<uid>` precedent from `reset.rs`/AGENTS). One
  or the other, decided by whoever builds it; either is fine, a runtime
  import is not.
- **It reads its OWN manifest** (`subshell` block of its own `package.json`),
  never tailscale's: its id, name, labels and docs URLs differ.
- **settingsFields:** `controlUrl`, required, type string, label
  "Control server URL", placeholder `https://headscale.example.com`. The join
  REFUSES without it: `{ refused: { text: "Headscale needs the URL of your
  control server before this machine can join." } }`.
- **Detection:** the SAME `tailscale` binary as the Tailscale plugin
  (same `knownPaths`, same `TAILSCALE_PATH`? NO — a distinct env override
  `HEADSCALE_PATH` would mislead: it is the tailscale binary. Set
  `binaryName: "tailscale"`, `envOverride: "TAILSCALE_PATH"`, same knownPaths
  list including `/Applications/Tailscale.app/Contents/MacOS/Tailscale` and
  the two Homebrew dirs.)
- **status:** as tailscale (shared daemon) with three differences:
  `CertDomains` is treated as always empty; the published check still reads
  `tailscale serve status`; and when `BackendState` is `Running` but
  `CurrentTailnet.Name` is absent, do NOT guess — report joined with the
  hostname only. `needs-privilege` and `daemon-down` map exactly as tailscale
  does (the same "Access denied" strings).
- **hints module:** not-installed sentence names Tailscale (the client) and
  the daemon steps are tailscale's (same two per platform, copied into THIS
  manifest); needs-privilege likewise; plus an `adminHint()` —
  "Ask your Headscale admin to register this machine (headscale nodes
  register …)" emitted in the `needs-login` state.
- **join (interactive):** `tailscale up --login-server <controlUrl>` with the
  `TAILSCALE_BE_CLI=1` env the tailscale plugin now uses; URL capture and
  abort exactly as tailscale's join does. **join (credential):** same plus
  `--auth-key=<cred>`.
- **publish:** try `tailscale serve --bg --http=80 http://127.0.0.1:<port>`
  (reset first, as tailscale does). If the CLI refuses, publish is a
  `{ refused: { text: ..., docsUrl } }` naming § 10.3 as unmeasured and
  pointing at the plain `http://<DNSName>:<port>` address the status already
  lists. Do NOT fabricate a published state on refusal.
- **unpublish:** `tailscale serve reset`. **leave:** `tailscale logout`.
- **exposure:** `private`. **interactiveLogin:** true. **No `install.command`.**
- **icon.svg:** a hand-drawn geometric mark, dark plate, letter-style —
  consistent with the other plugin icons. No trademarked vendor artwork.
- **Known limitation to document in the package README/docblock:** a machine
  can be on ONE tailnet at a time. With BOTH tailscale and headscale plugins
  enabled, each row reads the same daemon; whichever control server the daemon
  actually belongs to answers `joined` and the other may read it as joined too
  (the status cannot see `--login-server` post-hoc). The UI already shows both
  rows; the README states the pick-one rule. § 10.3 remains UNMEASURED —
  say so in code and in the master spec's amendments.

## 5. Plugin 2 — `netbird`

Independent binary and daemon. Decisions:

- **Package:** `packages/plugins/netbird`, id `netbird`, name "NetBird".
  Description: "Reach this server from your other devices over your NetBird
  network."
- **Detection:** `binaryName: "netbird"`, `envOverride: "NETBIRD_PATH"`,
  knownPaths `[".local/bin/netbird", "/usr/local/bin/netbird",
  "/opt/homebrew/bin/netbird"]` (absolute rule applies to the latter two).
- **status:** `netbird status --json`, defensively typed exactly like
  `TailscaleStatusJson` (every field optional, parse fails ⇒ `daemon-down`
  with the detail). Fields per § 4.5: management connection, `fqdn`, `peerIP`.
  **No `needs-privilege` state** — a socket/permission denial maps to
  `daemon-down` with a hint naming `netbird service install` (§ 8's
  peer-credentials claim is UNMEASURED per § 10.4 — the daemon-down hint text
  stays generic: "the NetBird daemon is not running or not reachable").
- **settingsFields:** `managementUrl`, optional, label "Management URL
  (self-hosted only)".
- **join (credential):** `netbird up --setup-key <cred>` plus
  `--management-url <settings.managementUrl>` when set. **join
  (interactive):** `netbird up --no-browser` reading the URL (and device
  code, if the output carries one) off `onLine`, then abort — same shape as
  tailscale's interactive join, same fallback-to-reread-status.
- **identity:** hostname + version where the status JSON answers them.
- **addresses:** `http://<fqdn>:<port>` and `http://<peerIP>:<port>`, both
  `secureContext: false`; publish emits the § 8 nameserver-group hint
  ("Peer names resolve only if your NetBird account has a nameserver group —
  otherwise use the IP address").
- **publish:** does NOT run a command — it returns the addresses (a join
  alone is enough for reachability); the state becomes `published`.
  **unpublish:** no-op returning ok. **leave:** `netbird down`.
- **privileged steps:** linux: the official install script
  (`curl -fsSL https://get.netbird.io | sh`, docsUrl
  `https://docs.netbird.io/how-to/installation`); darwin:
  `brew install netbirdio/tap/netbird && sudo netbird service install && sudo netbird service start`
  (same docsUrl). Both platforms' second-group alternative, mirroring the
  macOS Tailscale decision: NetBird ships a GUI app too —
  group label "The NetBird app (recommended)", command
  `brew install --cask netbird` with the docs link and a label sentence
  saying to open it and log in. Use the manifest `group` field (landed
  2026-09-16 with the tailscale macOS route).
- **exposure** `private`; **interactiveLogin** true; **No `install.command`.**
- **icon.svg:** simple placeholder mark (letter "N" monogram is acceptable);
  no trademarked artwork.
- **§ 10.4 remains UNMEASURED** — say so in code and in the master spec's
  amendments.

## 6. Plugin 3 — `cloudflare-tunnel`

The first real user of `supervise` and `guard`. Read the master spec § 5.2,
§ 5.3, § 6, and § 10d before writing a line — the host already implements the
supervisor, the guard machinery (with tests), the settings-write refusal, and
the disable/unpublish ordering; the plugin's job is to return the right
declarations, not to manage anything.

- **Package:** `packages/plugins/cloudflare-tunnel`, id
  `cloudflare-tunnel`, name "Cloudflare Tunnel". Description: "Publish this
  server on a hostname you own, behind Cloudflare Access." **exposure:**
  `public-with-gate`; **interactiveLogin:** false.
- **Detection:** `binaryName: "cloudflared"`, `envOverride: "CLOUDFLARED_PATH"`,
  knownPaths `[".local/bin/cloudflared", "/usr/local/bin/cloudflared",
  "/opt/homebrew/bin/cloudflared"]`.
- **install.command (darwin):** `brew install cloudflared` — the ONLY
  server-runnable installer among the plugins (§ 8). linux privileged step:
  the apt-repo lines from Cloudflare's docs as ONE copyable command, docsUrl
  to it.
- **settingsFields:** `hostname` (required, "Hostname", placeholder
  `subshell.example.com`), `teamDomain` (required, "Access team domain",
  placeholder `myteam`), `aud` (required, "Access application Audience tag"),
  `tunnelToken` (required, `secret: true`, label "Tunnel token").
- **join:** validates the token's shape — base64 of JSON whose decoded form
  carries the account/tunnel/token triple the § 4.5 table names — then
  `host.secrets.set("tunnel-token", cred)`; returns `joined`. A malformed
  token is a REFUSAL with a sentence saying where the token comes from
  (Zero Trust → Networks → Tunnels → the tunnel's connector). Nothing is
  spawned by join.
- **status:** binary present + settings present + the secret row exists ⇒
  the state machine is the HOST's: the supervisor reports running ⇔
  `published`, else `needs-login`… follow what `network-view.ts` and the
  NetworkStatus contract actually give a plugin whose daemon IS the supervised
  child; read phase 1's code and mirror its semantics — the plugin answers
  presence and settings completeness, never process state.
- **publish:** (a) refuse unless hostname/teamDomain/aud/token are all
  present; (b) the § 6 Access pre-flight — confirm an Access application
  covers `<hostname>` with that audience BEFORE anything runs, failing closed
  with the vendor's own words if the check errors; (c) return the `process`
  for the supervisor and the `guard` declaration. **The token never rides
  argv** (it is `ps`-visible on the host): hydrate it as the
  `TUNNEL_TOKEN` environment variable of the supervised child (the secrets
  contract supports env hydration — check `PluginHost.secrets` and the
  supervisor's hydration code and use what exists). § 10.5 (`--token-file`
  version floor, pre-flight status/header shape) stays UNMEASURED: the
  pre-flight code reads BOTH `Location` and the `cf_access_*` headers if
  present and treats any non-pass as refuse.
- **unpublish / disable / leave:** the host stops the process and drops the
  guard FIRST and LAST respectively (§ 5.3 ordering is implemented — do not
  re-implement it). `leave` deletes the secret (`host.secrets.delete`).
- **addresses when published:** `https://<hostname>` with
  `secureContext: true`, plus the disclosure that Access is the front door
  and Subshell's own login still runs behind it.
- **icon.svg:** simple placeholder cloud or "C" monogram; no trademarked art.

## 7. Wiring, for each plugin (three times)

- `packages/pane-runtime/src/registry.ts`: static import + entry beside
  `tailscale` (insert in name order: cloudflare-tunnel, headscale, netbird —
  merge will be cleanest if each branch adds exactly one import line and one
  list entry).
- `.changeset/config.json`: add the package to `ignore` (§ 3).
- Root `bun install` so `bun.lock` gains the workspace.
- A changeset under `"@internal/server": patch` (ONE per plugin) describing
  the plugin's arrival, naming the other apps nothing.
- `packages/plugins/<id>/README.md` (short) or docblock: what it does, its
  unmeasured § 10 items, and the pick-one-tailnet rule where relevant.

## 8. Testing, per plugin

Mirror the tailscale package's test style (`src/__tests__/<id>.test.ts`, fake
`PluginHost` recording argv, contract assertions):

- manifest parses (through `parseManifest` on the real package.json), type
  `network`, capabilities match the declared members (loader requires the
  per-type subset);
- detection data: binaryName/knownPaths pins (including absolute entries);
- join with and without a credential: exact argv, the required-setting
  refusal (headscale/netbird where applicable), the interactive URL capture;
- every `host.run` carries `TAILSCALE_BE_CLI=1` where the tailscale binary is
  driven (headscale only);
- status mappings per state, including a hostile/`{}` JSON and a socket error;
- publish refusal paths (missing settings, missing secret, headscale's serve
  refusal) never fabricate `published`;
- cloudflare: the guard/process declaration shape (argv contains NO token),
  the pre-flight refuses on a failed/absent check, token-shape validation;
- unpublish/leave argv pins.

Server-side: none of the three should need `apps/server/api` changes — the
routes, gate, supervisor, guard are plugin-agnostic. If a change seems needed
there, STOP and report it: that is a contract gap, not a plugin detail. (One
expected exception: nothing — seed tests that list built-ins may assert an
exact set; update those lists.)

Verification per branch: `bun install`, `bunx turbo build`,
`bun run verify-types`, `bun run lint:check`, `bun run lint:design`,
`bun run test` — all exit 0, reported with the summary lines.

## 9. Out of scope

- The operator npm bootstrap (§ 3) and removing the ignore entries.
- Live-vendor measurements (§ 10.3/4/5) — code degrades honestly and says so.
- Any UI change: the rows, cards, chips and privileged-step grouping already
  render manifest data these plugins emit.
