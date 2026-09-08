---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Make the addresses an instance answers to configurable, so signing in from
anything other than loopback no longer fails with 403 "Invalid origin". The
allowlist was derived from the port, a *concrete* `HOST` and `APP_BASE_URL` —
and on the default `0.0.0.0` bind the host is skipped and the base URL defaults
to `http://localhost:<port>`, leaving only the two loopback spellings. A phone
or a second hostname on the LAN sent an `Origin` nothing matched, and neither
key was reachable from the desktop.

Subshell Server console: **Public base URL** and **Other addresses browsers
will use** join port and bind address, seeded from what the server reports and
sent whole on save. `subshell-server configure` gains `--trusted-origins`
(entries validated by component and stored canonicalized, so a trailing slash,
a mixed-case host, expanded IPv6 or an explicit `:443` all work; wildcards and
embedded credentials are refused), and `status` reports `TRUSTED_ORIGINS` plus
per-entry `problems` — what a browser will *do* with a value the boot accepted,
and which config layer supplied it — which the console shows beside the field.

Node: `subshell configure --server <url>` repoints an enrolled node at a moved
control plane without re-enrolling — it keeps the node id, node key and pinned
control key, spends no setup key and mints no second node row (`enroll`, the
only previous route, did all three). Subshell Client gains a matching
**Repoint this node…** control, warns when its own control-plane address and
the node's have drifted apart, and repoints both together.

Fixes found along the way, all pre-existing:

- `localOriginsFor` built its derived entries by string concatenation, so on a
  port-80 deployment `http://<host>:80` matched nothing a browser sends (80 is
  the scheme default) — the LAN address 403'd while `localhost` worked, from an
  entry that looked like it covered it. Every entry is now serialized through
  `URL.origin`.
- `configure --port 080` was accepted and written, and the server then could
  not boot — nor could `status` or `configure`, which import the same module.
  The port must now be the canonical integer the boot accepts.
- A mixed-case scheme (`HTTP://host`) was stored verbatim, and the node's dial
  URL is built by replacing the scheme with a case-sensitive match, so the
  agent tried to open a WebSocket to `HTTP://host/ws/node` and never connected.
- `init --yes` reset every key it was given no flag for, so changing the port
  from the console silently repointed `DATABASE_PATH` and discarded a
  customised `APP_BASE_URL`. Stored values are now the defaults in every mode;
  flags still win. A value already on disk that this tool would not write is
  preserved with a warning rather than blocking the run.
- `subshell enroll --server "  http://x  "` stored the padded string, which
  became a dial URL with spaces in it.
