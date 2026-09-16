# @subshell-ai/plugin-headscale

Reach this server over your own self-hosted tailnet.

Headscale is the open-source control server for the Tailscale protocol. This
plugin drives the **`tailscale` client binary** (the same one the Tailscale
plugin drives, at the same install locations — there is no `headscale` package
to install on a client machine) pointed at a control server you run. It
implements the `type: "network"` contract (spec 2026-09-15 § 4): it describes
argv, parses output and names a required setting; the control-plane host is
what executes, bounds and audits every act.

## What it needs

- The `tailscale` client installed (Settings → Networking prints the copyable
  daemon-install steps; installing the client is privileged, so the server
  never runs it).
- A **Control server URL** saved under Settings → Networking → Headscale.
  Without it the join refuses — a bare `tailscale up` would not be "unset", it
  would enroll this machine into Tailscale's SaaS instead of your tailnet.
- An interactive join is finished by an **admin** (`headscale nodes register …`
  on the control server), so the needs-login row says so. A pre-auth
  (`tskey-…`) key joins without a human on either end.

## One machine, one tailnet — the pick-one rule

A machine can be on **one tailnet at a time**. With both the Tailscale and the
Headscale plugins enabled, each row reads the *same* daemon, and the status
cannot see `--login-server` after the fact: whichever control server the
daemon actually belongs to answers `joined`, and the other row may read it as
joined too. Enable both if you switch machines between tailnets; expect one
green row per machine.

## Publishing

Publish tries `tailscale serve --bg --http=80 http://127.0.0.1:<port>` (reset
first). **Whether Serve works against a given Headscale is UNMEASURED — design
spec 2026-09-15 § 10.3 — and this plugin shipped with that measurement still
open.** If the CLI refuses, publish returns an honest refusal that names the
unmeasured section and points at the plain `http://<DNSName>:<port>` address
the status already lists; it never reports a `published` state it did not
create. Headscale tailnets issue no HTTPS certificates (juanfont/headscale#2527),
so every address here is http with `secureContext: false` — passkeys and
`Secure` cookies will not work on them.

## Where the code came from

`src/cli.ts`, `status.ts`, `join.ts`, `publish.ts` and `hints.ts` are copied
from `@subshell-ai/plugin-tailscale` (the inline route spec 2026-09-16 § 4
names first — tsdown `noExternal` — cannot carry them: the tailscale package
exports only its factory and manifest, and inlining its module graph would
parse tailscale's own manifest at load). The shared argv constants are pinned
by a containment test in `src/__tests__/headscale.test.ts` so the two plugins
cannot silently disagree about one binary.
