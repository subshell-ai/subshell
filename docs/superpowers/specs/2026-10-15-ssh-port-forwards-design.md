# SSH Port Forwards

Status: design, for review. Dated 2026-10-15.
Branch: `feat/ssh-port-forwards`, cut from `origin/main`. This deliberately amends a
written non-goal: the relay spec (`2026-10-08-ssh-agent-relay-design.md` §1) listed
port forwarding out of scope, and the launcher refused it at three layers. The prior
specs stay as the record of why; this one records what changed and why it is sound.

## 1. Problem and goal

An SSH pane gives the user a shell on the destination D, dialed from the connecting
machine B. Plenty of services sit behind D: a database on D's private network, an
admin API, a staging box only D can see. Today reaching them means hand-running
tunnel commands inside the pane, and nothing in Subshell knows they exist.

This feature makes port forwarding a first-class part of an SSH connection. At
launch the user may declare forward rows, and the connection carries them for its
lifetime. All three OpenSSH kinds ship: local (`-L`), dynamic/SOCKS (`-D`), and
remote (`-R`). SSH presets can store rows, so "this host always forwards the DB"
is a preset, not a ritual. Forwards bind to loopback by default; letting them bind
wider is a per-machine owner decision.

## 2. What this changes, stated precisely

The refusal this feature inverts is real and was reasoned, so the inversion has to
name what exactly stays and what goes.

What goes: a config file the connecting account holds can no longer be the reason
nothing forwards. What stays: **a config file can never be the reason something
does.** The resolver keeps refusing `LocalForward`/`RemoteForward`/`DynamicForward`
found by `ssh -G`, by name, unchanged and pinned by test; the frozen snapshot keeps
`forwards` and `tunnels` as literal-null forbidden members; `Tunnel` (the tun
device) stays `no`, and `ForwardAgent`/`ForwardX11` toward D stay `no`. The M1
argument, "missing a forward would be the silent-widening defect," was always about
*ambient* directives the user never consciously approved. What ships here is the
opposite kind of thing: explicit user-declared rows, visible in the launch form,
saved in presets, audited at launch.

The widening is bounded by what the connection already grants. An approved `-L` or
`-D` gives B less than the shell on D that this very connection hands the user (from
inside the pane you can `socat` the same path by hand). An approved `-R` asks D to
bind a port, and D's sshd decides under `GatewayPorts`/`PermitRemoteOpen` exactly as
it would for any client; we relay the request and own the asking, nothing more. The
accounting goes into `docs/security.md` §SSH surfaces as a paragraph, not a patch-on-
a-refusal: config-derived forwards are still refused by name, and the new rows enter
through a different door.

## 3. Terminology

B, D, J keep the ssh-anywhere spec's meanings (connecting machine, destination, jump
hop). A **forward row** is one declared tunnel: a `kind`, a **listen** end (`bindHost`
+ `listenPort`, bound by B for local/dynamic, by D for remote), and for local/remote
a **target** (`targetHost` + `targetPort`, reached through D for local, through B for
remote). Dynamic rows have no target: the SSH channel decides destinations at runtime,
which is what makes a SOCKS proxy useful and is exactly the reach a shell on D already
has.

## 4. Row grammar

New protocol module `packages/subshell-protocol/src/ssh-forwards.ts`, pure and
Metro-safe like its neighbors:

- `SshForwardWire`: `kind` (`local` | `remote` | `dynamic`), `listenPort` (integer
  1..65535, always explicit; no ephemeral/auto ports), optional `bindHost`
  (canonical host/IPv4/IPv6, bracketed IPv6 kept, option-like leading `-` refused
  the way the snapshot grammar refuses it), and `targetHost`/`targetPort` required
  for local/remote and forbidden for dynamic.
- `parseSshForwardRows()`: the closed-shape rebuild discipline of
  `parseSshConnectionSnapshot`. Any bad row refuses the whole set (there is no
  "drop the bad one" in an approval list). Cap at 16 rows. Duplicate listen ends
  refused: same `bindHost` (canonically compared) and `listenPort` twice is a bug,
  not a configuration.

Rows ride the pane's ssh launch payload **beside** the snapshot, never inside it.
The snapshot is the resolver's output and its grammar says config-derived forwards
do not survive it; approved rows are user input from a different door, and keeping
the channels distinct is what lets the old refusal stay honest.

## 5. Rendering

`renderSshConfigContents` grows an options object, `{ relay?, forwards? }`. With
approved rows it emits a second config block, `Host <exact destination host>`,
**after** the `Host *` policy block, carrying `LocalForward` / `RemoteForward` /
`DynamicForward` lines composed only from re-parsed rows.

Two facts about OpenSSH make the placement the whole design. First,
`ClearAllForwardings` clears forwardings "specified in configuration files **or on
the command line**" at the point it is applied, so approved rows cannot ride argv
where the policy block would wipe them; they must be added after the clear, inside
the same file, which is also why the rows stay out of `sshOptionTokens` (those are
the destination-scoped facts the policy must not fight). Second, ProxyJump children
re-read the `-F` file matching their own host, so they hit `Host *` (policy,
cleared) and never match the exact final-host pattern: a forward cannot leak onto a
hop's connection.

Byte stability is kept (same approval renders the same file), so the run's recorded
config byte-check and spec-22's sweep keep working. `ExitOnForwardFailure` stays at
ssh's default: a busy port prints ssh's own warning into the pane and the session
carries on. The forward is auxiliary to the terminal, not its precondition, and the
form says so.

## 6. Trust and gates

- **Loopback is the default and the floor.** An omitted `bindHost` binds ssh's own
  loopback, same as typing `127.0.0.1`. Loopback binds on B are reachable by B's
  other OS users; that is §0's accepted posture verbatim, the same one the node's
  loopback dashboard already carries, and `security.md` says so in one sentence.
- **Wide binds are a machine decision.** A row naming a non-loopback bind host is
  refused at launch unless the connecting node's new `sshWideForwards` setting is on:
  owner-only (admin on `local`), cookie-only, default off, audited
  `node.ssh_wide_forwards.update`, presented on the node's SSH card beside the
  allow-SSH switch. Enforcement is plane-side only, deliberately: the node already
  gates the whole SSH subsystem, the render trusts the approved rows the launch
  carries, and a plane lying about the flag is the control-plane-compromise case §0
  accepts. A wide bind turns B into a router for whatever can reach that port; the
  setting is the owner saying their network is trusted enough for that, per machine.
- **-R binds are the destination's policy**, not ours; the copy names it.
- **Auth modes are untouched.** A forward is an option on the one already-approved
  connection. Password mode and the one-shot local-key path gain nothing new: rows
  never multiply connections, and the local-key signer still signs exactly once.
- **Older agents are refused, never downgraded.** A launch carrying rows toward an
  agent predating the grammar is refused by name with an "update this machine"
  remedy. Silently stripping a forward is precisely the silent-widening failure the
  resolver's refusal was written against; a dropped forward is a lie about what the
  user approved.

## 7. Surfaces

- **Launch form**: a "Port forwards" group inside the existing `ssh-advanced-options`
  disclosure. Per row: kind, listen port, optional bind host (only offered when the
  selected machine reports wide binds on), target host and port (hidden for dynamic),
  plus one detail-role line explaining what the kind does and where the port lives.
  The forward dies with the pane, and the copy says so.
- **Presets**: rows persist beside destination/auth/key choices (JSON column on
  `ssh_presets`), validated at save through the same parser, applied to the form like
  every other preset choice. A preset with rows is still unaudited CRUD, per the
  presets precedent; the launch itself audits.
- **Node overview**: the SSH card grows the wide-forwards toggle, owner-only.
- The pane itself gains no new live surface in this round; see §10.

## 8. Audit

`ssh.launch` metadata grows a bounded summary of the approved rows (kind, canonical
listen end, canonical target for local/remote). These are the same class of fact the
row already records (it names the destination), and they answer "which machine is
forwarding what" for a security review without a new event family. The wide-forwards
flip writes its own row in the nodes family.

## 9. Tests

- Protocol: accept/refuse census on `parseSshForwardRows` (both IPv6 spellings, port
  bounds, dynamic target rules, kind closedness, cap, dupes).
- Resolver: the config-forward refusal pins stay green (this change must not touch
  them; a test guards that a config `LocalForward` still fails resolution).
- Render: byte snapshots (policy-first ordering, the forward block, relay and
  forwards coexisting, the exact-Host pattern not matching the hop's host).
- Plane: launch route gate matrix (loopback vs wide bind x node setting off/on),
  min-protocol refusal, duplicate refusal, audit summary shape; preset save
  validation and round-trip.
- Node: launch re-validation of rows (a hostile list cannot render), config
  byte-check still passes.
- Web: draft round-trip, bind-host gating on the node flag, preset editor rows.
- E2E: extend spec 22's real-sshd pattern: launch with a `-L` row and curl the bound
  loopback port for the fixture's bytes; a `-D` leg through `curl --socks5-hostname`;
  a `-R` loopback-bind leg; the wide-bind refusal before the toggle and acceptance
  after. Assert the recorded config carries the forward block and the `Host *` clear.

## 10. Non-goals and follow-ups

- Not managed-tunnel objects: no start/stop apart from the pane, no live tunnel
  list, no health. If forwards outgrow the pane, that's a new spec.
- No ephemeral/auto ports (a row without a port has no honest audit story).
- No way to use a forwarded port from the browser or the desktop app's machine;
  forwards terminate on B, where the ssh process lives.
- No pane-header "active forwards" display yet; the launch audit and the pane's ssh
  config are the record.
- `ForwardAgent`, `ForwardX11`, and `Tunnel` toward D stay refused: this feature is
  TCP port forwarding, and nothing here opens those doors.
