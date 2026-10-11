# @subshell-ai/plugin-cloudflare-tunnel

The Cloudflare Tunnel network plugin for Subshell: publishes this server on a
public hostname you own. Cloudflare Access controls who can reach it, and
Subshell still requires sign-in. The plugin ships with Subshell and is also
available as a package. See `@subshell-ai/plugin-api` for the runtime contract.

## What it does

- **Join** stores the tunnel connector token (base64 of the JSON carrying
  the `a`/`t`/`s` triple) in the host's write-only secret store. Nothing
  spawns: with Cloudflare the token *is* the connector's identity.
- **Publish** refuses unless the hostname, team domain and Access application
  AUD are all set and the token is stored, then runs the Access pre-flight:
  `fetch https://<hostname>/` with `redirect: "manual"`, passing only on
  positive evidence of Access (a `Location` to `https://<team>.
  cloudflareaccess.com/…`, or any `cf-access-*` header). Everything else,
  including a failed or unreachable check, refuses. Failing closed is the
  contract of a `public-with-gate` exposure.
- On a pass it returns a `SupervisedProcessSpec` (`cloudflared tunnel run
  --no-autoupdate`) and nothing else; the guard comes from `requestGuard()`,
  the single source the route and every boot ask. The host supervises the
  process, hydrates the token into the child's `TUNNEL_TOKEN` **environment**
  at spawn (never an argv element, never visible in `ps`) and drops the
  guard only after the child is stopped and reaped.
- **Leave** deletes the stored token. The tunnel, its public hostname and the
  Access application are the operator's Cloudflare resources; this plugin
  never creates, edits or deletes them.

## What is unmeasured (§ 10.5, spec 2026-09-15)

The initial implementation wasn't tested against a live Cloudflare account.
These two assumptions still need verification:

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

This package participates in the repository's Changesets versioning.
Subshell bundles it with the server, so users don't need to install the npm
package separately.
