# @subshell-ai/plugin-cloudflare-tunnel

The Cloudflare Tunnel network plugin for Subshell: publishes this server on a
public hostname you own, with a Cloudflare Access application as the front
door. Part of Subshell's built-in plugin set (this package is also published
standalone for tooling; nothing at runtime imports it as a bare specifier —
see `@subshell-ai/plugin-api`).

## What it does

- **Join** stores the tunnel connector token — base64 of the JSON carrying
  the `a`/`t`/`s` triple — in the host's write-only secret store. Nothing
  spawns: with Cloudflare the token *is* the connector's identity.
- **Publish** refuses unless the hostname, team domain and Access application
  AUD are all set and the token is stored, then runs the Access pre-flight:
  `fetch https://<hostname>/` with `redirect: "manual"`, passing only on
  positive evidence of Access (a `Location` to `https://<team>.
  cloudflareaccess.com/…`, or any `cf-access-*` header). Everything else —
  including a failed or unreachable check — refuses. Failing closed is the
  contract of a `public-with-gate` exposure.
- On a pass it returns a `SupervisedProcessSpec` (`cloudflared tunnel run
  --no-autoupdate`) and nothing else; the guard comes from `requestGuard()`,
  the single source the route and every boot ask. The host supervises the
  process, hydrates the token into the child's `TUNNEL_TOKEN` **environment**
  at spawn — never an argv element, never visible in `ps` — and drops the
  guard only after the child is stopped and reaped.
- **Leave** deletes the stored token. The tunnel, its public hostname and the
  Access application are the operator's Cloudflare resources; this plugin
  never creates, edits or deletes them.

## What is unmeasured (§ 10.5, spec 2026-09-15)

No live Cloudflare account was available while this was built, so two
assumptions remain measurements-not-taken, and the code is shaped to degrade
honestly rather than to pretend:

- **The pre-flight's exact status codes and header names.** The reader takes
  the `Location` header or any `cf-access-*` header *if present* as the
  positive cases and refuses every other answer. If Access spells its
  pre-redirect differently on some path, the failure mode is a refusal to
  publish beside the button, never an unguarded publish.
- **cloudflared's version floor for token handling.** The token rides the
  connector's environment (`TUNNEL_TOKEN`), which is the older and broadly
  supported spelling; `--token-file` was not used, so its 2025.4.0-era floor
  is not this plugin's floor. The supervised spec deliberately declares **no
  `readyPattern`**: the exact line `cloudflared` prints when its first
  connection registers was never observed, and a guessed pattern that misses
  would report a healthy tunnel as never-ready. Alive-is-ready is the
  contract's fallback, and a connector that cannot authenticate exits rather
  than idling, so backoff and parking still carry the failures that matter.

## npm bootstrap status

This package is in `.changeset/config.json`'s `ignore` list: its `0.0.1`
hand-publish and trusted-publisher configuration (the operator step recorded
in spec 2026-09-15 § 10c) have not happened. Until they do, `0.1.0` is not
separately installable from npm — nothing a user does depends on that, because
the plugin ships compiled into the server binary as a built-in.
