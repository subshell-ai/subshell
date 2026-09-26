# config.env, the trusted-origin registry, and the tmux preflight. Moved verbatim from AGENTS.md ("Standalone binary & CLI" > "config.env"); AGENTS.md keeps the summary and routes here.

### config.env (`src/config-env.ts`)

`~/.config/subshell-server/config.env`, home overridden by
`SUBSHELL_SERVER_CONFIG_DIR`; dir 0700, file 0600, written via temp +
rename. `constants.ts` itself applies it with SETDEFAULT semantics at the
top of its own module body, BEFORE its dotenvx call, so the precedence is
**process env > config.env > `.env` (dotenvx, when the CWD has one) >
built-in defaults**. The application lives in `constants.ts` rather than in
`cli-bootstrap.ts` on purpose and by measurement (2026-09-07): the
bootstrap's body runs AFTER the whole import graph has evaluated: its own
first import (`@/cli.js` → `commands/status.js` → `constants.js`) reaches
constants first, so a bootstrap-side apply silently did nothing on macOS,
where launchd has no `EnvironmentFile` to mask the gap the way the systemd
unit does. `cli-bootstrap.ts` keeps its (idempotent) call for the CLI path;
the regression test spawns the real entry and asserts the FILE's value
reaches the RUNNING process (`__tests__/cli-entry.test.ts`). One visible
consequence: `bun run dev` now honours the developer's own config.env too;
a `configure`d `DATABASE_PATH` relocates the dev server on its next restart.
That is the point (one machine, one configuration), but it is why
`e2e/stack.ts` points `SUBSHELL_SERVER_CONFIG_DIR` at its own temp dir;
anything that boots the server for test purposes and wants stock config must
override the home, not merely avoid setting variables. `configure` owns five keys (`SERVER_PORT`, `HOST`,
`APP_BASE_URL`, `DATABASE_PATH` and `TRUSTED_ORIGINS`), and `init` persists the
secret (an existing value is never rotated).

**`applyConfig` is the ONE writer.** The merge over the stored values, the
per-key `validateValue`, the origin canonicalization, the two address warnings
and the atomic preservation-preserving rewrite are one exported function
(`commands/configure.ts`), called by `runConfigure` and by
`PATCH /api/admin/server/config` alike. So the component-wise validation
`docs/security.md` §8 leans on is true of the web surface because it IS the
CLI's code, not because a second implementation was kept in step. Be exact
about what carries that claim: no test diffs a route-written file against a
CLI-written one; the shared CALL is the guarantee, and there is simply no
second writer to drift. What the route's own test pins is narrower (the write
lands, foreign keys survive, the audit metadata holds no secret).

**Validation therefore runs twice, on purpose.** `runConfigure` checks each
answer at its own prompt, so an interactive typo dies at the question that
produced it rather than after four more questions the person would have to
retype; `applyConfig` then checks the whole set again, because the API path has
no prompts to die at. Both passes call the same `validateValue`, so this is one
set of rules in two places rather than two sets. The same is true of the
leniency: a value byte-identical to what is already stored is kept with a
warning in both, which is what keeps a hand-written wildcard from wedging an
unrelated port change.

Two things about that set are load-bearing and were both bugs first:

- **Defaults follow the FILE, in every mode.** A stored value is the default
  for its question, so ENTER through an interactive re-run *and* a `--yes` run
  given no flag for that key both keep what is configured. `--yes` used to
  answer with the built-ins alone, which made a scripted re-run a RESET of
  every unflagged key, contradicting `init`'s own idempotence contract, and
  with a live victim: the desktop console's save is a non-interactive
  `init --yes --port … --host …`, so changing the port there repointed
  `DATABASE_PATH` at the config-dir default and threw away a customised
  `APP_BASE_URL`. Flags still outrank the file everywhere. The other half of
  that interaction is WARNED rather than silently fixed: preserving a stored
  `http://box.local:3080` across `--port 4000` leaves a base URL naming a dead
  port (and an allowlist around the wrong origin), so `configure` says so when
  the base URL names a concrete non-default port that disagrees with the bind
  port. A default-port base URL is a PROXY, not a mismatch; warning on
  `https://subshell.example` in front of `:3080` would fire on every correct
  production config.
- **`TRUSTED_ORIGINS` is the OPERATOR's extras; network plugins no longer
  write it (2026-09-16); their addresses are derived from their records by
  `services/network/origins.ts` into the live registry.** It is written or
  REMOVED, never written empty (`OPTIONAL_KEYS` in `commands/configure.ts`).
  The other four have a built-in
  default worth writing down; this one's built-in default is a non-empty list
  (the dev Vite origins), so a `TRUSTED_ORIGINS=` line would be a
  SETDEFAULT-visible empty value that beats `.env` in the ladder and silently
  strips those origins on a developer's own machine. `--trusted-origins` is
  therefore the ONE value flag whose empty value is accepted; that is how
  "clear the list" is said, now that omitting a flag means "keep the stored
  value". Entries are validated by COMPONENT (http(s) scheme, a host, no
  path/query/fragment) and STORED as `URL.origin`, so the spellings people type
  (a trailing slash, a mixed-case host, expanded IPv6, an explicit `:443`)
  are accepted and written in the one form both consumers match; embedded
  credentials are refused rather than silently dropped. The refusal names the
  offending entry. **Wildcards are refused explicitly**, before that check,
  because `URL.origin` round-trips them: better-auth routes any `*`/`?`
  pattern through `wildcardMatch`, so `https://*` would trust every https
  origin. See `docs/security.md` §8; that refusal is what makes the
  static-allowlist claim true of anything these surfaces can write.

`localOriginsFor` serializes every derived entry through `URL.origin`, and that
is load-bearing rather than tidy: as string concatenation, `http://<host>:80`
on a port-80 deployment matched nothing a browser sends (80 is the scheme
default, so the `Origin` header carries no port), and a mixed-case `HOST` never
matched either, a derived entry that LOOKS like it covers the LAN address
while being dead weight. Extend the `localOriginsFor` describe in
`__tests__/trusted-origins.test.ts` when touching it; `port: 80` and an
uppercase host are the cases that catch this class.

**The trusted-origin registry.** `services/trusted-origins.ts` owns the live
allowlist: `localOriginsFor(port, host, baseUrl)` ∪
`lanOrigins(port, host)` ∪ the operator's `TRUSTED_ORIGINS` extras ∪ one
canonicalized set per enabled network plugin.
better-auth calls the registry's function form per request and the CORS plugin
calls `corsOriginAllowed` (`server.ts`) per request, so a network joined a
minute ago is trusted without a restart, while the SOURCES stay static:
nothing is ever derived from a request's Host or Origin (§8's DNS-rebinding
rule, unchanged).

`services/lan-origins.ts` is the fourth source and the only one that reads the
KERNEL: this machine's non-internal IPv4 addresses, and ONLY on a wildcard
bind; a concrete `HOST` already contributes its own origin above, and a
loopback bind would put rows in the mobile picker that connect to nothing. The
entry stays inside the rebinding rule because a LITERAL IP can only be matched
by an `Origin` spelling that literal IP, and a rebinding attack's browser
always sends the hostname it typed. It exists for the 403, not the reach: the
LAN bind always answered on these addresses, but the allowlist named only
loopback spellings, so a phone scanning the "Subshell for Mobile" QR scanned
into a sign-in that refused it. The probe is re-asked by `refreshLocal()`,
which `GET /api/settings/public` calls; interfaces change with no act to hook
(Wi-Fi switch), that read is the beat before a phone is handed an address, and
this is deliberately NOT the five-minutes-timer class below: the timer answers
for plugins a signed-in reader will never fetch for, and this one is re-asked
exactly when the answer is about to be used. The answer feeds the picker
THROUGH the same `trustedOrigins` field; no client-side guess at "which of
these addresses is my LAN", because the picker's promise is that every row
accepts a sign-in, and only the registry knows what the registry trusts. `services/network/origins.ts` is the single derivation of the
plugin sets; every write goes through `originsOf`, and each set derives from
the plugin's RECORD, never from a status in hand: a `private` network's addresses are trusted from `joined` (the tailnet
address answers with no publish at all, so membership is the honest scope), a
`public-with-gate` network's only once the record says `published`, i.e. only
once the Access guard is installed. Disable, uninstall and leave forget a
plugin's contribution (`forgetNetworkOrigins`). Every address a plugin reports
passes `canonicalPluginOrigin`, refused if unparseable, if it serializes to
`"null"`, or if it carries `*`/`?` in the origin component (a `?` there is a
vendor value truncated at a query separator; pattern characters after the
authority are path or query, which `URL.origin` discards, so they are not
refused), and a refused entry is dropped with a warn, never thrown: a bad
address costs that plugin one entry, not the allowlist. Boot is three moments
(`services/network/origin-refresh.ts`): seed from the records BEFORE the
listener, one probe per enabled plugin once the processes are armed, then the
same probe every five minutes. That timer is a deliberate exception to
"detection runs when someone asks" (`prepare.ts`'s `reportIfDown`), argued at
the module; node harness detection has since grown one on the same argument
(see "Node harness inventories refresh themselves" in `apps/server/api/docs/self-management.md`): the allowlist is
consulted on every sign-in by people who will NEVER open the Networking page,
and the cost is bounded to one memoised `status()` per enabled plugin, skipping
a supervised plugin whose child is armed. Refreshes are observations, not acts:
they log at info when the set changes and write NO audit row; the audited
events are the acts that change plugin state
(`network.join|publish|unpublish|leave`, `plugin.enable|disable|uninstall`). And `corsOriginAllowed` is EXACT membership since
2026-09-16: the server passes its own predicate rather than the plugin's string
list, which closes the schemeless-entry branch (`box.local:3080` matched both
schemes through `@elysiajs/cors`' string form) for anything an env var or
hand-edit still carries. One test fact worth knowing here: better-auth 1.7.1
SKIPS the origin check under `isTest()` unless `advanced.disableOriginCheck:
false` is passed, which is why `api/__tests__/live-origins.test.ts` mounts its
own auth instance rather than reusing `AUTH_OPTIONS`.

**Why the diagnostics live in `status` and not at boot.** Neither refusing nor
warning at boot works. A throw in `constants.ts` would brick every subcommand,
`configure` included, the one command that could repair the value, which is
the `SERVER_PORT=70000` precedent already in the tree. And a boot WARNING
cannot name the LAYER the value came from, so a process-env override of a
correct `config.env` would send the operator to edit the file they got right.
`status` is read-only, always exits 0, already carries per-key attribution, and
is what the desktop console reads, so the diagnosis reaches the surface
someone runs BECAUSE sign-in is failing, and the console renders it beside the
field that changes it. `originProblem`/`baseUrlProblem` live in
`commands/config-values.ts` and share primitives with the validator rather than
duplicating it: a `status` that called a value unusable when `configure` would
accept it (or the reverse) would make the tool look broken instead of the
config. Wildcards are the deliberate silence; better-auth honours them, so
flagging one would be a lint against a supported feature. And note what
`status` answers about: the OPERATOR's key, what a boot WOULD start from. The
running server's effective list (the derived local origins, that key, plus
every plugin's addresses) is `GET /api/settings/public → trustedOrigins`,
which is live.

Why the key is still asked about at all, now that `lan-origins.ts` derives the
machine's own addresses: `constants.ts` derives the static part from the port,
a CONCRETE `HOST` and the base URL. On the default `0.0.0.0` bind the host is
skipped (a wildcard is a listen address, not one anyone visits) and
`APP_BASE_URL` defaults to `http://localhost:<port>`. What is left for the
operator after the LAN derivation is the names the machine answers to that are
NOT its own interface addresses: a `.local` hostname, a DNS name, a reverse
proxy's domain. The phone on the Wi-Fi is covered without it now; a laptop
browsing `http://box.local:3080` still sends an `Origin` only this key (or the
base URL pointed at that name) can name, and the 403 it dies on still names
nothing. That is why it is a question rather than a hand-edit.
`DEFAULT_TRUSTED_ORIGINS` lives in `constants.ts` and is imported by `status`,
so the reported default cannot drift from the one the boot uses.

tmux preflight: `init`, `configure` and
`service install` refuse before any write when tmux is absent (the `local`
node launches every pane through it); escape hatch
`SUBSHELL_SERVER_SKIP_TMUX_CHECK=1`. On an INTERACTIVE run the preflight
first OFFERS to install tmux (`commands/tmux-install.ts`: brew, then
MacPorts, then a Homebrew bootstrap on macOS; `sudo apt-get`/`dnf` on Linux;
fixed argvs, inherited stdio so sudo prompts land in the user's own terminal)
and CONTINUES the command on success, no rerun.
Since the operator ruling of 2026-09-26 the gate is three-valued for
`init`/`configure`: `--yes` IS the yes and RUNS the same installer with no
prompt. For `init` the preflight also runs FIRST, and a declined or failed
install ABORTS before any write (the message names the manual command, notes
the installed binary, and gives the rerun). The Homebrew bootstrap prompts
for an admin password, so a run with no terminal prints its instructions
instead of attempting it, and the server's own installer route refuses it by
name. A prompt-less refusal with no supported installer falls back to the
plain refusal, byte-identical to before (CI never gets asked); a refusal
taken with nobody to ask at all (no TTY, no `--yes`) adds one line naming
that remedy. `service install` takes no `--yes`, so its offer keeps the
2026-09-03 TTY-only rule unchanged.
