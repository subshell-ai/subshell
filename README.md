<div align="center">
  <img src="docs/assets/subshell-wordmark@2x.png" width="640" alt="Subshell" />
</div>

# Subshell

Subshell keeps your interactive coding agents running in tmux panes on machines
you own, and lets you reach them from any device you actually have. Launch a
real CLI agent from a browser, close the tab, walk away. The pane keeps
working, and the next screen you open shows the same live terminal you can type
into. Self-hosted end to end: no one else's cloud sits between you and your
agents.

- **Bring your own agents**: six harness plugins ship built in (Claude Code,
  Codex, OpenCode, Hermes, pi, and Terminal, which needs nothing installed);
  harnesses are packages behind the published `@subshell-ai/plugin-api` contract.
- **One binary, your hardware**: the control plane is a single self-contained
  file per platform with its web UI embedded: no Bun, no checkout, no separate
  frontend. Data is a SQLite file you back up yourself.
- **Every device is a client**: phone, tablet and desktop get the same adapted
  web UI; Add to Home Screen makes it a standalone app with push notifications,
  and the native Subshell Server / Subshell Client apps wrap the install and
  your day-to-day window onto a control plane.
- **Workspaces**: tile subshells side by side. Add one into the layout from
  its header, split from a subshell's own page, or drag; the same workspace
  becomes tabs on a small screen.
- **Agents that coordinate**: end-to-end-encrypted channels (the server stores
  only ciphertext it cannot read) plus a `subshell mcp` server wired into every
  agent subshell, so siblings can read each other's panes and post to each
  other.
- **Sharing with disclosure**: a subshell is private to its owner by default;
  grant view or edit to Everyone or named users, and anything shared, or
  running on a node you don't own, carries a permanent indicator on its pane.
- **Nodes**: enroll another machine and launch subshells on it. Commands are
  signed, panes stream back over the transport local ones use, and the browser
  cannot tell the difference.
- **Network plugins**: publish the server on Tailscale, Headscale, NetBird or
  Cloudflare Tunnel; the address that starts answering becomes one you can sign
  in from, with no hand-edited allowlist.

## Quickstart

One command installs and starts the control plane on the machine that will run it:

```bash
curl -fsSL https://subshell.sh/install-server.sh | bash
```

It verifies the release's `.sha256` before making anything executable, then runs
`subshell-server init` and prints the address where you create the first
account. Rather not touch a CLI? The
[Subshell Server desktop app](https://docs.subshell.sh/get-started/install-server#subshell-server-desktop-app)
installs the same binary behind a button. To run agents on other machines,
[enroll a node](https://docs.subshell.sh/nodes/add-node); to work from your own,
open the server in any browser or use the
[Subshell Client](https://docs.subshell.sh/nodes/client-as-node).

## Documentation

**[docs.subshell.sh](https://docs.subshell.sh)** is the user-facing docs site:

- [Quickstart](https://docs.subshell.sh/get-started): from nothing to a running
  subshell you can watch from any device
- [Nodes](https://docs.subshell.sh/nodes): what a node is and what enrolling one delegates
- [Server](https://docs.subshell.sh/server): install, configuration, service,
  networking, users, backups, updates

Everything this README used to carry (the desktop apps, Docker, the env-var
tables, the security and remote-operation notes) lives on the site now.

## Contributing

- [Contribute to Subshell](https://docs.subshell.sh/develop/contribute-to-subshell):
  the dev loop. `bun install`, `bun run start`, and the verification trio every
  change runs through.
- Contributions need the one-time [CLA](CLA.md): it keeps the server AGPL while
  non-AGPL commercial licensing stays possible.
- Root [AGENTS.md](AGENTS.md) is the operational source of truth: builds,
  releases, CI, migrations, and the project vocabulary.

## Engineering references

Repository paths, readable offline:

- [docs/security.md](docs/security.md) is the authoritative threat model: what
  is defended, and what deliberately is not.
- [docs/design-system.md](docs/design-system.md): the design contract every
  surface follows, enforced by `bun run lint:design`.
- Per-app `AGENTS.md` files. The tree under `apps/` groups by the three words
  the product uses: a **server** is the control plane, a **node** is a machine
  that runs agents, a **client** is a person's interface to a control plane:
  [`apps/server/api`](apps/server/api/AGENTS.md),
  [`apps/server/web`](apps/server/web/AGENTS.md),
  [`apps/server/desktop`](apps/server/desktop/AGENTS.md),
  [`apps/node/agent`](apps/node/agent/AGENTS.md),
  [`apps/client/desktop`](apps/client/desktop/AGENTS.md),
  [`apps/client/mobile`](apps/client/mobile/AGENTS.md),
  [`apps/docs`](apps/docs/AGENTS.md), [`e2e`](e2e/AGENTS.md).
- Design rationale in `docs/superpowers/specs/`; build plans in
  `docs/superpowers/plans/`.

## License

Subshell is dual-licensed, and the line is the directory tree:

| path | license |
|---|---|
| `apps/server/**`: the control plane (API, the SPA it serves, its desktop app) | **AGPL-3.0-only** |
| everything else: the `subshell` node agent, the client apps, every shared package and crate | **Apache-2.0** |

**Self-hosting Subshell is free.** No time limit, no user cap, no feature clock,
no license key. That is not a trial; it is the deal, and it is written into
both licenses and into the [CLA](CLA.md).

The permissive half is permissive on purpose: write harness plugins, embed the
node agent, and build tools on the subshell protocol without inheriting
copyleft. The AGPL covers only the piece someone would fork into a competing
hosted service. If you run a modified control plane as a network service, you
owe your users its source.

**Building an API client is not copyleft either.** `apps/server/LICENSE` carries
an additional permission under AGPL section 7, the *API Type Surface
exception*, letting you use the control plane's TypeScript type declarations
(routes, request/response shapes, WebSocket frames, MCP tools, the exported
`App` type, and any `.d.ts` generated from them) under Apache-2.0 rather than
the AGPL. Only the implementation is copyleft. So an SDK, a CLI, a bot or a
dashboard built against Subshell's API carries no AGPL obligation, however you
ship it.

Contributions require a one-time [Contributor License Agreement](CLA.md). You
keep the copyright in your work; the CLA grants the right to license it, which
is what lets the server stay AGPL while non-AGPL commercial licenses remain
available to organizations whose policies forbid the AGPL.

**Commercial licensing.** Subshell is copyright Disaresta, LLC. If your organization
cannot use AGPL-licensed software, non-AGPL commercial licenses for the control
plane are available; contact Theo Gravity <theo@disaresta.com>.

Full text: [`LICENSE`](LICENSE) (Apache-2.0) and
[`apps/server/LICENSE`](apps/server/LICENSE) (AGPL-3.0).
