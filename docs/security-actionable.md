# Security follow-ups and audit history

## Live penetration checks: 2026-10-29

This pass exercised the deployed HTTPS instance and a separate running copy of
`security/codebase-audit-2026-10-29`. No additional security defect was reproduced.
The application under test in the disposable stack was revision `c650765c5`;
the fixes below have not been deployed by this audit.

### Deployed endpoint

`https://subshell.ein.disaresta.com` passed **49 checks**, including availability
controls. Requests were anonymous or used the current pane's existing credential.
No administrator or second user's deployed credentials were available. The
checks covered:

- Anonymous access to protected API routes, credential-type restrictions on
  node artifacts, dotfile requests, an invalid preview capability, and encoded
  or normalized auth-plugin paths.
- A working current-pane credential, refusal on admin and cookie-only surfaces,
  invalid credentials, and an invalid cookie taking precedence over a valid bearer.
- Refusal to mint unbound or foreign-pane terminal tickets; refusal of foreign
  and opaque origins on terminal upgrades; refusal of pane credentials on the
  node socket; and terminal-ticket binding, single use, and rejection on the
  instance live feed.

Two initial SSH-identity probes supplied an incomplete query and returned 400.
The corrected `?node=local` request returned the expected 403. Those two attempts
are retained with their correction in the local evidence and excluded from the
49 passing checks. A random absent pane id returned 404; cross-account ownership
was tested with known resources in the disposable stack below, not inferred
from that response.

The deployed checks minted and consumed two short-lived tickets for this pane.
They sent no terminal input and changed no accounts, shares, nodes, files, or
deployment settings. The endpoint remained available after the probes.

### Disposable running stack

[`e2e/verify-live-security.ts`](../e2e/verify-live-security.ts) passed **58 checks**
using real HTTP, terminal WebSockets, Chromium, tmux shells, a newly enrolled
node, and an nginx container. It boots the existing E2E stack with test mode
disabled and an isolated database and configuration; it imports no server
internals and uses no test-only application endpoints. Three disposable accounts
exercise administrator, owner, and unrelated-user authority.

| Boundary | Observed result |
| --- | --- |
| Ownership and privilege | Foreign pane reads, logs, input and deletion refused; admin had no private-pane override; self-promotion and ordinary-user key minting refused |
| Restricted credentials | Read-scoped system key could list but could not execute, mint terminal access or enroll; disabling it invalidated the next request |
| Sharing and terminal input | View access allowed reading and rejected input/forwarding; the same terminal accepted input after an edit grant; share changes closed the old socket and revoked issued preview links |
| Browser isolation | Embedded and directly opened previews had opaque origins; parent DOM, cookies, storage, dashboard API access and service-worker registration were blocked |
| Browser request forgery | Same-site foreign-origin POST and WebSocket attempts failed; an authenticated HTTP positive control reached the shell |
| Proxy credentials and cookies | Dashboard authorization, cookies and edge assertions were absent at the target; target cookies stayed in the server-side jar |
| Reverse-proxy instructions | All tested file-serving headers were removed; direct nginx forwarding served a private canary through `X-Accel-Redirect`, while forwarding through Subshell returned the ordinary preview without the canary |
| Local upload writes | Planted directory link refused without an outside write; a hard-linked Git exclude file retained its bytes and mode; ordinary uploads succeeded |
| Node upload writes | Directory escape refused over the enrolled-node link; planted symlink and hard-link temporaries left victim bytes and modes untouched; normal upload and ignore-file creation succeeded |
| Node previews and revocation | Preview isolation survived the encrypted node link; deleting its subshell invalidated the capability |
| Disabled accounts | Existing cookie access and preview capability failed; the auth session cache did not resurrect the disabled account |

The node temporary-file probes target the fixed-name `.gitignore` seed sent
before an upload. Its best-effort refusal does not fail the upload itself;
the assertions inspect the outside victim and verify that no ignore file was
published through the planted link. Removing the link restores normal creation.

The nginx fixture used `nginx/1.31.8`, pinned to
`nginx@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606`.
Its canary and internal location were disposable. Two initial runs stopped at
fixture startup: first a response-property error in the runner, then nginx's
default temporary-directory location on a read-only filesystem. Both were fixed;
the final run completed all checks and cleanup.

### Evidence and limits

The redacted local reports are `/tmp/subshell-live-audit/deployed.json` and
`/tmp/subshell-live-audit/isolated.json`; the latter can be regenerated with the
checked-in runner. They contain outcomes, not credentials or response bodies.
The E2E package type check and three helper tests passed. Lint passed with three
existing warnings outside the new runner. The test plan selected the E2E package;
this pass ran the targeted live runner rather than the entire browser suite.
All fixture processes, containers, tmux sessions, accounts and temporary data
were removed, and their listening ports were released.

Deployed browser/account-to-account behavior, native macOS consent, mobile
clients, compiled release artifacts, Apache/lighttpd interpretation, and denial
of service were not exercised. Successful branch tests do not establish the
deployed revision or prove the absence of other vulnerabilities.

## Adversarial follow-up: 2026-10-29

This second pass continued on `security/codebase-audit-2026-10-29` after the
audit below. It traced restricted credentials through derived tokens and
resource access, then tested filesystem and preview-response inputs that can
redirect an otherwise authorized operation. All attack fixtures used temporary
files, isolated test databases, or test listeners. The running instance was
not targeted.

### Confirmed findings and fixes

1. **Medium: planted workspace links redirected local upload writes.**
   The local upload service sanitized the filename and used exclusive creation,
   but followed directory symlinks at `.subshell` and `.subshell/uploads`.
   A prepared workspace could therefore send an upload and its ignore-file
   creation outside the documented working-directory boundary. This requires
   control over workspace contents and a subsequent authorized upload; the
   uploaded filename remains sanitized and timestamp-prefixed, so this is not
   an arbitrary existing-file overwrite. Both directory components now have to
   be real directories before any upload or ignore-file write.

   The same operation's optional Git bookkeeping followed `.git` and
   `.git/info` directory links and appended through an `exclude` symlink or
   hard link. That could modify an unrelated file with the fixed ignore line.
   It now rejects directory links, opens the leaf without following links,
   verifies a regular inode with one link, and reads/appends through that
   descriptor. Six service regressions failed before the fix and pass after it;
   they verify that outside directories stay empty and victim bytes and modes
   stay unchanged. A route regression verifies a 400 `BAD_REQUEST` without an
   outside write. Ordinary uploads, name collisions, concurrent writes, and
   best-effort ignore handling still pass. Hostile OS-user races remain outside
   the threat model; these checks do not provide a filesystem sandbox.

2. **Medium, with deployment-dependent impact: preview targets could still
   emit file-serving directives for an outer proxy.** The first pass stripped
   nginx's `X-Accel-*` family, but `X-Sendfile`, `X-Sendfile-Temporary`,
   `X-Sendfile2`, and `X-LIGHTTPD-send-file` still escaped. The composed-app
   test returned the target's `/private/instance.db` directive before this fix;
   all four are now removed while the ordinary response remains intact.
   An outer proxy configured to honor them could replace the response with a
   file from its own host. Apache's optional temporary-file variant can also
   delete the file when its configured path permits deletion. These semantics
   are documented by the [mod_xsendfile author](https://github.com/nmaier/mod_xsendfile)
   and [lighttpd](https://redmine.lighttpd.net/projects/lighttpd/wiki/Mod_fastcgi).
   This extends the first pass's reverse-proxy finding. No live Apache or
   lighttpd deployment was used, and installations that don't enable those
   features don't have that file-serving exposure.

### Other paths examined

Source review covered provider-policy hooks and better-auth's account-linking
inputs; session-cache handling after revocation; versioned system-key checks,
derived-token ceilings and restart intersection; node-management actor gates
and setup-key disclosure; preview opening/revocation coordination; SSH native-key
session ownership; MCP path construction; and transfer/archive confinement.
No additional reproducible authorization bypass was established in those paths.
That is a bounded review result, not evidence that those subsystems are free of
defects. The documented same-account execution authority, preview capability
links, and lifetime of independently issued credentials remain unchanged.

The working security summary had drifted from the implementation on system-key
scopes and node management. It now describes explicit grants and the remaining
cookie-only actions instead of claiming that all system keys have full access
or that all bearer node-management requests are refused.

### Validation and limits

The affected server package passed **4,942 tests across 386 files**, including
HTTP/WS preview integration and CLI backup subprocess tests. Its type check
passed; lint passed with 39 existing warnings outside the changed code. The
new regressions demonstrated the defects before the fixes. A changeset covers
the server CLI and the desktop server that bundles it.

This pass did not rerun the node/runtime/protocol suites from the first audit
because their implementation did not change. It did not perform browser E2E,
native macOS testing, a full release build, an external penetration test, or
continuous fuzzing. Neither audit is a guarantee that every security defect
has been found.

## Codebase security audit: 2026-10-29

Work was isolated on `security/codebase-audit-2026-10-29`, starting from a clean
tree. This was a risk-based source review with local exploit regressions, not
an exhaustive review of every file or an external penetration test. No checks
targeted the running instance, and no release or deployment was performed.

### Confirmed findings and fixes

1. **Medium: a read-only pane credential could acquire terminal write access.**
   `POST /api/auth/ws-token` checked the pane binding and inherited system-key
   ceiling, but omitted the pane's own `subshells.write` permission check. A
   valid, row-linked pane key narrowed to `subshells: ["read"]` received a
   token that the attach resolver treated as its pane owner's terminal access.
   This does not require a forged key or a foreign pane. The route now calls
   `requirePerm` before minting. The regression in `ws-token-route.test.ts`
   returned 200 before the fix and now returns 403 without a token. Existing
   cookie, writable-pane, system-key, foreign-pane, and capacity tests pass.
   Ordinary newly issued pane keys already carry write permission; the defect
   affected enforcement of narrowed permission maps.

2. **Medium, potentially high with protected nginx locations: preview targets
   could issue instructions to the deployment's reverse proxy.**
   `/pv/:session/*` forwarded target-controlled `X-Accel-*` response headers.
   A target returning `X-Accel-Redirect: /private/instance.db` could therefore
   ask an outer nginx proxy to perform an internal redirect. Exposure depends
   on that proxy's configuration and accessible internal locations; this is
   not an unconditional file-read vulnerability in Bun. `X-Accel-Expires` can
   also influence caching of capability responses. The HTTP proxy now strips
   the whole family before returning the response. The composed-app regression
   demonstrated the redirect header escaping before the fix and checks its
   removal alongside cache, buffering, charset, and rate directives. Ordinary
   response bytes and isolation headers still pass through correctly.
   The nginx behavior is documented in its
   [proxy module reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ignore_headers).
   A live nginx deployment was not used in this audit.

3. **Medium: linked upload temporaries bypassed the intended file boundary.**
   The node's shared `write_file` / `transfer_write` receiver checked the final
   destination but wrote and chmodded its predictable `.<name>.part` path
   using operations that followed links. A pre-existing symlink could redirect
   the first write; a hard link could modify an unrelated inode even though
   its pathname remained inside the allowed directory. Replacing the temp
   between chunks also redirected append operations before the eof check.
   The receiver now gates temporary and final paths before writes, opens with
   `O_NOFOLLOW`, checks that the opened inode is regular and has one link, and
   only then truncates, chmods, or writes through that descriptor. Publication
   preserves the descriptor-set mode instead of chmodding the destination by
   name. Tests verify unchanged victim contents and permissions, no published
   destination, and discarded stream state. Both upload and unrestricted
   transfer paths are covered, as are replacements between chunks. The four
   original upload attack cases failed before the fix. This closes planted
   links; it does not claim to sandbox a hostile local OS user racing ancestor
   replacement between filesystem calls, which remains outside the threat model.

### Review coverage

The detailed review concentrated on REST credential derivation, permission
ceilings, the auth-provider passthrough, terminal token mint/redemption, pane
ownership and sharing resolution, preview open authorization and HTTP/WS
forwarding, and node chunked writes. Additional source inspection sampled
channel identity/envelope handling, upload/transfer gates, node event routing,
command signing and replay checks, path confinement, archive extraction and
backup capture, registry integrity, signed-release verification, and the desktop
client's committed-origin/native-key boundary. Existing tests exercise more
paths than were manually inspected; their passing is not a claim that those
entire subsystems received a line-by-line audit.

The review retained the documented trust decisions: same-OS-user execution,
trusted administrators and in-process plugins, configured filesystem browsing,
capability-bearing preview links, and the loopback dashboard's local-user
exposure. Already-issued terminal tickets and connections surviving system-key
revocation are explicitly documented behavior, not an overlooked fix here.

The live dependency gate reported one allowlisted advisory, for `deepmerge`.
Its checked-in patch is covered by the dependency-security test, including the
installed Expo consumer. The audit did not add an exception or change a dependency.

### Validation and remaining scope

Validation used isolated test databases and temporary files:

| Check | Result |
| --- | --- |
| Server package | 4,935 passed |
| Node package | 1,293 passed; two non-Linux cases skipped on Linux |
| Pane runtime package | 598 passed |
| Protocol package | 573 passed |
| Dependency-security regression file | Four passed |
| Live dependency audit | One advisory, already patched and allowlisted |

Server and node type checks passed. Their lint
checks passed with existing warnings outside the modified code. Each confirmed
finding has an executable regression; a four-app patch changeset includes the
desktop bundles that ship the affected CLIs.

No macOS native execution, full browser E2E run, compiled release matrix,
live reverse-proxy penetration test, fuzz campaign, or comprehensive mobile/CI
audit was performed. Native OS consent, installed updater behavior, deployment
configuration, and dependency advisories outside the Bun audit feed remain
separate validation work. The normal release gates still apply before shipping.

## Preview reliability PR audit: 2026-10-28

Reviewed PR #467's discovery probes, CDP fallback and handshake, capability URL
rewriting, XHTML injection, navigation refusals, frame messages, title handling,
and terminal input controls against the boundaries in security §11.15.

1. **Medium, availability: malformed CDP target lists escaped the handshake.**
   A local endpoint returning an array containing `null` could throw in the
   detached discovery task and reach the process's unhandled-rejection path.
   Target rows are now narrowed before use, malformed lists are rejected, and
   the task's terminal catch closes the handshake through its normal refusal.
   Tests cover malformed-only lists and malformed rows alongside a valid target.
2. **Low, dashboard disruption: refusal notifications were unbounded.**
   The embedded app knows its capability ref and can send the same message as
   the refusal document. Source-window checking prevents other windows from
   impersonating this frame; it does not authenticate a server-generated page.
   A panel now emits at most one fixed-copy notice per capability/reload. The
   channel remains informational and grants no action or permission.
3. **Low, compatibility: a page-controlled chunk base could widen URL rewriting.**
   A blank Turbopack base matched unrelated stylesheet URLs and could throw on a
   malformed existing URL. Cache-busting now requires a Next.js chunk base inside
   this preview's own capability path. A real-browser regression covers blank
   and foreign bases, malformed links, and unchanged unrelated stylesheet URLs.

The review also corrected IPv6 CDP fallback when IPv4 returned non-CDP JSON and
resolved advertised `localhost` against the family that supplied the target
list. Explicit non-loopback, cross-port, credential-bearing, and fragment-bearing
WebSocket URLs remain refused, and a real-socket test pins that upgrade redirects
do not dial a different loopback port. The terminal's existing edit-access checks remain:
normal-buffer scrolling is local, while alternate-buffer navigation sends input
and affects the shared program. Those controls now display the keys they send.

Validation includes focused regressions, affected package tests and type checks,
and the Chromium preview isolation check: embedded and direct opaque documents,
blocked parent/storage/cookie/API access and service-worker registration, working
modules, POST, WebSocket and EventSource traffic. This is a source audit with
local regressions, not an independent penetration test. The iPad desktop-UA gap,
older WebKit fetch-metadata gap, and bearer-link and execution-account risks
remain explicit limitations; no sandbox or permission boundary was relaxed.

## Display provider refactor audit: 2026-10-25

This review covered the provider registry, Xvfb lifecycle, signed node settings,
node configuration and readiness authorization, persisted launch/restart choices,
presets, viewer descriptors, and MCP reporting. It found and corrected:

1. **Medium: concurrent allocations could publish the same RFB port.** Both
   launches could probe a free port before either x11vnc process bound it. The
   answering listener could then satisfy readiness for both displays. Candidates
   are now reserved before probing, and allocation and recovery verify that the
   IPv4 loopback listener's socket inode belongs to the intended x11vnc PID.
   Regressions reproduce concurrent selection, a foreign responding listener,
   and refusal to recover a record pointing at someone else's listener.
2. **Medium: asynchronous readiness could outlive permission.** The runtime
   checked the feature and provider settings before awaiting readiness, then
   allocated without checking again. It now rechecks both settings before
   allocation. Tests revoke each independently while readiness is pending and
   assert that no allocation occurs.
3. **Low: provider operations could overlap for one subshell.** Concurrent opens
   could each observe no owner, and a close could finish before an asynchronous
   provider published its allocation. Per-subshell operation ordering now makes
   later opens observe the owner and makes cleanup wait for the pending work.
   The regression overlaps two providers and a close, then checks that the
   competing provider never allocates and no display remains.

The follow-up review retained the existing trust model: bundled providers are
trusted host code; node owners control allowed providers, and subshell agents
cannot change node settings. Readiness and MCP capability reports grant no
permission. Defaults are resolved before persistence, restarts retain that
provider, and disabled settings leave existing displays running. The no-password
loopback RFB and local OS-user limitations remain documented in
[security §11.15](security.md#1115-web-previews-and-virtual-displays).

## Preview feature audit: 2026-10-24

This targeted review followed the discovery, open/watch, HTTP/WS proxy,
broker, local runtime, enrolled-node runtime, and workspace-layout paths.
It found and corrected six issues across browser isolation, authorization,
credential handling, lifecycle, diagnostics, and display allocation:

1. **High: website JavaScript shared the dashboard origin.** App iframes lacked
   a sandbox and direct preview documents had no response-enforced isolation.
   A malicious website could access dashboard DOM/storage and make authenticated
   API requests as the person checking it. App viewers now use an opaque-origin
   iframe sandbox, and every proxied response enforces the sandbox for direct
   tabs too. Target cookies stay in the server jar, preview responses cannot set
   dashboard cookies, and no-referrer/no-store policies reduce link retention.
   Preview-only CORS and `Origin: null` WS handling preserve modules, fetch,
   and HMR-style tunnels without trusting that origin on dashboard endpoints.

2. **High: a view grantee could choose another browser port.** The watch route
   accepted an explicit CDP port with only view access to any shared subshell
   on that node. A guessed port could expose another subshell's browser frames.
   View-only requests now have to match the CDP port discovered for their own
   shared subshell. Owners and edit grantees retain explicit-port support,
   consistent with their existing shell authority. The REST regression verifies
   refusal before opening a bridge.

3. **Medium availability: display allocation ignored other data directories.**
   Each runtime started at `:90` with locks in its own data directory. A second
   isolated server collided with a display already running on this host, then
   failed the readiness budget. Allocation now skips existing host X sockets
   and X lock files; a unit regression covers externally occupied numbers.
   Xauthority prevented the observed collision from becoming screen access.

4. **Medium: runtime diagnostics printed complete preview references.** The
   initial forward probe used the future browser capability reference, so a
   runtime log line could disclose a usable link secret. Forward and CDP
   lifecycle diagnostics now retain only an eight-character correlation prefix.
   Reverse-proxy and browser-history retention remain operator concerns.

5. **High: proxy headers could cross the dashboard trust boundary.** Browser
   HTTP authorization and known edge-identity headers could reach a dev server;
   upstream origin-wide headers such as `Clear-Site-Data` could affect dashboard
   state. The HTTP proxy now strips these credentials and forwarded identity,
   along with target storage-clearing, HTTP-authentication, HSTS, and Alt-Svc
   response headers. Regressions verify both directions. Custom authentication
   headers outside the recognized families still need operator review.

6. **Medium: explicit subshell stops relied on the exit hook for revocation.**
   Deleting a subshell could leave its capability registered after the row was
   gone; a real browser regression observed a 500 instead of a revoked-link 404.
   Existing connections also needed teardown independent of the exit hook.
   Terminate, delete, and restart now await broker teardown before stopping the
   old pane. Unit tests cover all three actions, owner checks, and ordering;
   the Chromium regression verifies deletion immediately invalidates the URL.

The real-Chromium check in `e2e/capture-preview-demo.ts --security-only` verifies
embedded and direct preview documents against a disposable server: opaque
origins, blocked parent/storage/cookie/API reads and service-worker registration, and working ES modules, JSON POST
preflights, and application WebSockets. The same checks run in CI through
`e2e/tests/48-preview-browser-isolation.spec.ts`. Unit tests cover proxy headers and cookie
separation, foreign and opaque WS origins, watch-port authorization, reference
ownership, revocation, caps, and saved-layout parent binding. The capture also
exercises real dev-server forwarding and Linux virtual-display rendering.

This is a source audit and targeted regression pass, not an independent
penetration test. Native macOS behavior, other browsers, all framework-specific
HMR/login flows, reverse-proxy log retention, and mutually untrusted local OS
users were not exhaustively tested. Accepted bearer-link, loopback RFB,
execution-account, cookie-jar, and resource-usage limits are stated in
[security §11.15](security.md#1115-web-previews-and-virtual-displays).

## Preview follow-up audit: 2026-10-24

A second implementation review tested the asynchronous open and revocation
paths, CDP destinations, proxy parsers, and target-controlled browser policy.
It reproduced and corrected four further boundaries:

1. **High: revocation missed opens waiting for node acknowledgement.** The
   broker registered sessions only after the RPC completed. An app or watch
   could therefore finish opening after share removal, account disable,
   subshell teardown, or node loss had swept the registered sessions. Eight
   held-ack regressions failed before the fix. Pending opens now participate in
   those sweeps, recheck account/access/liveness/node availability before
   publication, and close late node registrations. Explicit lifecycle actions
   sweep again after the old row is retired or parked, covering opens that
   arrived while the process was stopping.

2. **High: CDP answers could redirect discovery or repoint a watch at another
   loopback browser.** `/json/version` and `/json/list` followed HTTP redirects;
   the returned WebSocket URL needed only a loopback hostname. Discovery now
   refuses redirects, caps JSON at 256 KiB, and aborts on timeout or cancellation.
   A WebSocket URL must retain the requested port, use WS/WSS, and contain no
   credentials or fragment. The localhost alias is normalized to a literal
   loopback address. Pending handshakes count toward node capacity and can be
   cancelled individually.

3. **Medium: target responses could grow proxy memory beyond lane budgets.**
   HTTP chunk parsing buffered whole declared chunks, the browser response
   queue and unread duplex had no byte cap, and the upstream WebSocket receiver
   accepted unbounded fragmented messages. HTTP chunks now stream incrementally;
   queues, unread lane bytes, browser WS debt, and WS messages are capped at
   1 MiB. Malformed framing and truncated bodies fail without retrying writes.
   Cookie jars retain at most 128 entries and 64 KiB, with a 4 KiB cookie limit.
   Target Content-Length is dropped so the proxy controls browser framing.

4. **Medium: target reporting headers could persist policy for the dashboard
   origin.** NEL, Report-To, Reporting-Endpoints, Accept-CH, and Critical-CH now
   join the response-header denylist. A dev server cannot use those headers to
   enroll the dashboard in its network-error reporting or client-hint policy.

Regressions exercise late acknowledgements after each revocation, changed
access at publication, redirects without destination contact, foreign loopback
CDP ports, oversized discovery JSON, slow HTTP readers, huge chunk declarations,
malformed/truncated framing, fragmented WebSocket limits, cookie eviction, and
response-header filtering. The Chromium and enrolled-node preview checks remain
the end-to-end coverage for ordinary traffic. The original audit's scope and
remaining trust boundaries still apply; this does not claim general denial-of-service
protection or OS-user isolation.

## Additional preview race and resource audit: 2026-10-24

A further review reproduced three more issues. Nine regression cases failed
before their fixes:

1. **High: a pending live-screen subscription could outlast revocation.**
   `/ws/live` checked access asynchronously, then registered the viewer. A
   share or user sweep during that check found no registered viewer to remove;
   the old permission answer could then attach the socket and receive another
   viewer's active screencast. Revocation now advances a broker revision before
   its first await. Subscription checks retry when that revision changes,
   failing closed after three attempts. They also recheck account disable and
   required password changes before attaching.

2. **Medium availability: a non-reading target could grow the node's TCP
   write queue.** Browser-to-target writes ignored socket backpressure. The
   runtime now checks queued bytes plus the incoming frame against the 1 MiB
   lane budget and closes the lane with `slow-link` before exceeding it.
   This applies while connecting as well as after connection. A real Bun TCP
   probe confirmed that stalled writes appear in `writableLength`.

3. **Medium availability: uncertain open replies could strand node resources.**
   Timeout and malformed-reply paths discarded the server reservation without
   closing the node reference. Probes, forward lanes, and screencast bridges
   now attempt a close when the reply cannot establish the outcome, and verify
   the acknowledged reference. An explicit node refusal still propagates
   unchanged. Cleanup is best effort when the node is unreachable; link loss
   and the existing lifetime ceiling remain the fallback.

Regression coverage includes share and user revocation during subscription,
disabled accounts before socket closure, bounded authorization retries, a
stalled TCP writer, and uncertain replies across all three open paths. The
earlier audits' scope and accepted trust boundaries still apply.

## Preview authorization and allocation audit: 2026-10-24

The next pass found and fixed five more issues:

1. **High: an edit-to-view downgrade could preserve an arbitrary watch port
   during an open.** The publication check required view access but did not
   repeat the view-only port restriction. It now checks the discovered CDP
   port against current access, and repeats authorization when a share sweep
   overtakes an asynchronous permission read. Tests hold both the node reply
   and a permission read across the downgrade.

2. **Medium availability: image metadata and decoder inputs could request
   excessive allocations in the dashboard.** Screencast dimensions and encoded
   sizes are checked at the runtime, protocol, broker, and browser boundaries.
   The browser checks JPEG frame headers before image decoding. The noVNC
   integration also bounds framebuffer, cursor, and rectangle dimensions,
   queued rendering, and embedded JPEG/PNG dimensions. It refuses animated
   PNGs and the unused H.264 path. Clipboard messages, which ScreenViewer
   does not expose, are consumed within a byte budget without decompressing
   extended clipboard data. Real-class regressions pin the noVNC integration
   to the installed 1.7 API. These guards limit allocations; they do not claim
   to sandbox browser codecs or prevent an authorized execution program from
   using CPU.

3. **Medium availability: the encrypted node transport could queue preview
   traffic outside the lane limits.** Both senders now check the WebSocket's
   buffered bytes before sealing. Refusal leaves encryption state untouched;
   a failed write after sealing closes the connection rather than continuing
   a secretstream with a missing frame. A TCP forward closes on its first
   undeliverable output instead of silently skipping bytes.

4. **Medium availability: inactive capabilities and pending opens had no
   independent capacity limit.** The broker now admits 64 retained forward
   capabilities and 32 pending opens per node, counting reservations before
   any await. Its discovery cache holds at most 512 entries and checks node
   identity as well as pane identity. Existing lane and bridge limits remain
   independent. This bounds retained state, not overall authenticated API
   request rate.

5. **Medium availability: display cleanup trusted saved PIDs.** A reused PID
   could be signalled as an old display child. Rehydration, liveness checks,
   and teardown now verify the executable name and this display's exact
   Xauthority argument through Linux procfs. A mismatched process is never
   signalled. This is a stale-process guard, not isolation from malicious code
   running under the same OS account; the process can still exit between the
   check and signal.

The same pass corrected screencast acknowledgements to echo CDP's numeric
session identifier. That correctness fix keeps real browser captures flowing
while their images pass through the new guards.

### Final pass and verification

After the fixes, another pass reviewed REST and live-socket authorization,
publication and subscription races, bearer capabilities and revocation, proxy
headers/cookies/origins, HTTP and WebSocket framing, both encrypted-link send
queues, discovery and CDP destination validation, browser decoding, display
process ownership, and retained resource budgets. It found no additional high-
or medium-severity issues within the preview threat model in §11.15.

The affected server, node, web, protocol, and shared-runtime suites passed,
as did all 56 type/build dependency tasks and 170 documentation tests.
The aggregate run exposed a frontend-build/test race; the affected server
suite passed on its own after the build. Three Chromium scenarios covered
setup/login, enrolled-node previews, and embedded/direct browser isolation.
A real Chromium screencast emitted 12 accepted frames across repeated
repaints, and the updated noVNC integration rendered a real 1280×800 x11vnc
screen through the built-in node. Real PNG and JPEG captures passed the
encoded-image guards. The manual test login was checked through Vite on 5174.
This is the stopping point for this targeted audit, not a guarantee that no
vulnerabilities exist outside the reviewed paths or accepted trust model.

### Dependency audit outside the preview runtime

The two Expo-tooling advisories found during review have been addressed:
[Zod collection validation](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
no longer appears after updating all resolutions to 4.6.7, including a scoped
Expo CLI override with schema compatibility checks.

[node-forge signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
has no published fixed release as of 2026-10-25. The tracked Bun patch for
1.4.0 backports the nested DigestAlgorithm element-count validation proposed
in [upstream PR #1152](https://github.com/digitalbazaar/forge/pull/1152).
The regression test reproduces acceptance of malformed signatures without
the patch, confirms rejection with it, and checks valid signatures and
certificates through the same installed Forge used by Expo CLI and
`@expo/code-signing-certificates`. These are mobile build/dev dependencies,
not dependencies of the shipped preview runtime.

The version-based audit still reports Forge 1.4.0; its exception now records
the tested mitigation. Replace the patch and remove the exception once a
fixed upstream release is available. This does not claim that Forge has no
other vulnerabilities.

## Targeted code audit: 2026-10-21

This pass reviewed authentication and scoped credentials, node enrollment and
command transport, SSH relay authorization, terminal attachment, filesystem
uploads and transfers, and channel routing against the existing threat model.
It reproduced and patched two authorization defects:

1. **High: cookie requests lacked an origin gate outside better-auth.** A
   form-encoded POST from an untrusted origin reached a protected mutation
   with the victim's cookie. The CORS middleware hid its response but allowed
   the write. The terminal's cookie fallback also accepted a WebSocket upgrade
   from that origin. An attacker needs a page on the same site as the instance
   for the browser to send its SameSite cookie; terminal access additionally
   needs a known subshell id. `authGuard` and the separate setup/network
   credential gate now check cookie requests against the live trusted-origin
   registry, and `/ws` and `/ws/live` check origins before upgrading.
   Missing Origin remains supported for native clients;
   explicitly supplied bearer credentials retain their existing REST policy.
   `api/__tests__/browser-origin.test.ts` exercises real session cookies,
   form submissions and database effects, live origin changes, bearer
   precedence, and real WebSocket handshakes on an ephemeral loopback port.
   The form mutation and foreign-origin upgrades succeeded before the fix.
   The tmux installer regression also proves that an untrusted origin cannot
   reach installer selection with an admin cookie; it reached that step
   before the fix. Network management uses the same setup credential gate.

2. **Medium: a node could tear down another pair's SSH relay.** Normal frames
   checked the authenticated sender against the pairing, but oversized frames
   lost that identity and called `closeRelay(ref)`. A node knowing a relay's
   routing id could close it without belonging to either side. Routing ids
   are diagnostic identifiers, not credentials. The rejection path now passes
   the authenticated node id into the broker and checks membership before any
   state, timer, peer-command or audit effect. The regression reproduced the
   unauthorized teardown; it now verifies that an unrelated sender changes
   nothing and either legitimate participant can still trigger the refusal.

`bun run audit:deps` reported eight advisories across seven packages, all
covered by existing entries in `scripts/dep-audit.ignore.json`. Those
exceptions remain unresolved dependencies, not a clean vulnerability scan.
This was a targeted source audit and regression exercise, not exhaustive
coverage of the native desktop/mobile apps, all deployment configurations,
the release supply chain, or a live-instance penetration test. The accepted
OS-user, administrator and control-plane trust boundaries remain as documented.

The browser distinction matters here: SameSite is weaker than same-origin,
and cross-origin writes need server-side protection. See
[MDN's CSRF guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/CSRF).

## API surface follow-up: 2026-10-21

The main API router mounts 190 method/path pairs: 166 inherit `authGuard`,
including its scoped-key permission check, and 24 use an explicit public,
conditional, or capability-based boundary. The follow-up also examined the
auth passthrough outside that router, administrator and node gates, ownership
checks on resource handlers, and the setup/network exceptions.

**Low: GET requests bypassed the self-service API-key block.** Elysia selected
`GET /api/auth/*` before the more specific `ALL /api/auth/api-key/*`, so a
signed-in user could reach better-auth's key listing and lookup. Listing
returned 200 where the application's policy required 403. The upstream reads
remain caller-owned and omit the key itself; no privilege escalation or
plaintext-key disclosure was demonstrated. The block now runs inside the
passthrough before any session lookup or vendor handler, regardless of method.
Regression tests cover create, list, and lookup; both GET cases failed before
the patch and pass afterwards.

`api/__tests__/api-surface-auth.test.ts` now checks the composed route table:

- Every route either carries the shared authentication and permission hooks
  or appears in a named exception inventory. A newly unguarded endpoint fails.
- All 166 ordinary routes reject anonymous requests and verified node keys.
- Administrative route families retain the cookie-admin guard. Their reads
  reject ordinary users and system keys.
- Setup and network exceptions reject missing credentials after first setup.

The exception inventory records the actual boundaries: public sign-in metadata
and setup status; cookie-authenticated setup progress and installers;
conditionally public built-in plugin setup; cookie-admin network operations;
downloads authenticated by a cookie, setup key, or update ticket; setup-key
enrollment; encrypted paired-node discovery; and expiring restore-status
capabilities. Existing tests separately exercise those credentials and
resource ownership. This inventory is a regression control, not a substitute
for reviewing a route's business logic, fuzzing every payload, or testing
deployment-specific proxies and authentication providers.

## Authentication, content, restore, native and update follow-up: 2026-10-22

This pass traced five additional areas through the current implementation:

| Area | Boundaries reviewed | Result |
| --- | --- | --- |
| Authentication and recovery | Provider enablement and linking policy, OAuth state/PKCE and configured callbacks, passkey challenge/session/RP binding, disabled/pending accounts, emergency login and restore password recovery | No additional exploitable bypass confirmed. Provider configuration remains an administrator trust decision. |
| Browser rendering | Terminal byte sinks, ordinary and OSC 8 links, OSC 52 clipboard requests, stored text and URL rendering | No HTML injection sink found for pane output. Terminal links restrict schemes; clipboard reads are refused and writes require a click. |
| Backup and restore | Tar path/type/duplicate checks, expanded-byte limits, authenticated decryption before parsing, SQLite schema checks, stage ownership/expiry and recovery-session revocation | No additional bypass confirmed in the reviewed paths. Restoring plugins remains an explicit administrator code-trust decision. |
| Native permissions | Both apps' capability manifests, committed-page trust, chosen-origin binding, local key picker/unlock separation, signer ownership, host/session binding and expiry | No additional privilege bypass confirmed. Native platform behavior was reviewed from source and tested through the Rust suites, without driving installed apps. |
| Release and update delivery | CLI manifest verification, node re-verification, release signing/merge pipeline and both desktop installers | One desktop artifact-substitution gap patched, below. |

**Medium: desktop bundle signatures did not bind the advertised app/version.**
Both desktop apps trusted a publisher signature over the downloaded bundle,
while the version and URL came from unsigned `latest.json`. A compromised
release host could advertise a newer version while serving an older signed
bundle or the other desktop app. This requires control over release delivery
and a user initiating installation; it does not permit arbitrary unsigned code.
The new check verifies the existing signed release manifest's component,
selected newer version and platform filename, then hashes the exact downloaded
buffer before installation. Tauri's bundle-signature check remains in place.
Check and install both refuse missing or invalid manifests. CI already publishes
these signed manifests, so the patch needs no new signing key or release format.

`crates/desktop-core/tests/release_verification.rs` uses real Tauri-generated
signatures from a throwaway key. Its regression demonstrates that an older
payload passes the bundle signature check and fails the new manifest digest
check. It also rejects another component/version, an absent platform asset,
altered manifest bytes and wrong/missing signatures. No test installs a bundle.
Tauri documents the distinction between signed installer artifacts and the
JSON update feed in its [updater guide](https://v2.tauri.app/plugin/updater/).

This remains a source audit with regression tests, not a certification. It does
not exercise every live identity provider, browser/WebView platform or release
installation, inspect CI secret custody, or retest the mobile application.
Dependency follow-up (2026-10-22): five of the eight advisories are resolved.
Root overrides select glob 11.1.0 for hash-runner, uuid 11.1.1 for xcode,
decode-uri-component 0.5.0 and image-size 2.0.4. Versioned Bun patches adapt
query-string's decoder import and Metro's file input to those fixed APIs.
Remove each override and its matching compatibility patch when the consumer
accepts the fixed API upstream; rerun the consumer regressions and dependency
audit before doing so. The patches are install-time Bun patches, recorded in
the lockfile, and were verified in a fresh frozen install.
Consumer regressions exercise Node interoperability, malformed URL decoding,
zero-length ICNS entries, image and non-image asset loading, UUID generation
and glob matching. The Android JS export also builds successfully.

Three exceptions remain: node-forge, braces and sprintf-js have no published
fix. Their exposure and removal conditions remain in
`scripts/dep-audit.ignore.json`. No exception remains for the five fixed
advisories.

## Earlier documentation sweep: 2026-09-23

**STATUS: Rounds 1–3 CLOSED. Round 3 (14 items from four adversarial sweeps:
credentials/WS, injection/labels, races/TOCTOU, updates/deps) was implemented
2026-09-24; the sweeps found NO bypass of any guard, and Round 3's items were
the REAL bugs at the edges they conceded, defense-in-depth, and dependency
hygiene.** Open now: only the two trigger-held items (R5/R6) and the
"deferred by decision" lists, which are open BY CHOICE. Rounds 1–2 records are
condensed at the bottom.

Ground rules unchanged: the trusted-network posture (§0, §12) is settled;
"environment wins", fail-closed shapes, and "ids never secret-values in audit
metadata" are the patterns to preserve. After code: `bun run verify-types &&
bun run lint:check && bun run test`; SPA touches `lint:design`; `packages/`
touches also `bunx turbo build`.

## Resolved: Round 3, 2026-09-24 (adversarial sweeps)

### C1. ✅ Manual rename bypasses the pane-title sanitizer (M · S) **[REAL]**
Subshell create/rename and workspace names run `.trim()` + a 120-length schema
check ONLY (`api/subshells/update-subshell-name.route.ts:38`,
`create-subshell.route.ts:15`, `workspaces/create-workspace.route.ts:9`) while
the AUTO path (harness OSC) passes `normalizePaneTitle`
(`subshell-manager.service.ts:1884-1902`, Kitty-query-laundering-hardened).
Raw ESC/CR in a name reaches the operator's JOURNAL verbatim
(`subshell-manager.service.ts:756` interpolates `${parked.name}` into
`logger.info` on the pinned-stdout transport; `ESC[2K`+CR blanks the line in
`journalctl`) and other users' screens (React-escaped, so display-safe; the
journal is the injection sink). A harness can rename ITSELF with control bytes,
defeating the sanitizer's own threat model. Fix: route ALL three paths through
`normalizeLabel`; refuse empty. Tests per route.

### C2. ✅ `normalizeLabel` hardening: NFC, format chars, surrogates (L · S)
Survivors verified by probe: bidi overrides U+202B/202D/202E
("Server‪ppa" renders "Serverapp", a node-name spoof), ZWJ/ZWSP/VS16,
U+E0041 tag chars (fully invisible; labels reach SIBLING AGENTS verbatim via
`list_subshells` → invisible prompt-injection anchors), unpaired surrogates;
no NFC (NFD/NFC "café" mint two visually identical rows). Fix: prepend
`normalize("NFC")`, drop category `Cf` + unpaired surrogates; all three
bindings inherit.

### C3. ✅ Attach journal interpolates User-Agent unclamped (L · S) **[REAL]**
`ws/attach-resolve.ts:148`: `ua="${ua.slice(0,90)}"`; a quoted-closure + ANSI
attach line lets ANY authenticated caller (including a pane's own bearer)
forge/clobber the `ws attach` journal lines the AGENTS doc leans on. The
sibling `build=` field already has the right clamp (`attach-params.ts:147`,
`[A-Za-z0-9_.-]`). Fix: same clamp (or `normalizeLabel`) on `ua`.

### C4. ✅ Server update route: check→await→set, not CAS (M · S) **[REAL]**
`api/admin-server/update.route.ts:130` checks pending/running, then AWAITs
release + audit before `start()` sets the job; two concurrent POSTs both pass,
share one `${name}.download-${pid}` tmp (`services/releases.ts:799`), and the
loser's cleanup unlinks the winner's bytes mid-flight (update aborts, UI
flaps; wrong-binary impossible, marker bookkeeping survives). Desktop has
exactly this CAS (`ActionGuard::try_new`). Fix: synchronous claim (re-check +
set immediately before `start`, or claim at handler top before the first await).

### C5. ✅ Update swap has a no-binary window; use link + single rename (L · S-M)
All three swappers rename-aside THEN rename-in (`server-update.ts:265→273`,
`commands/update.ts:358→366`, node `update.ts:603`); a kill/power-loss in the
inter-statement gap leaves NOTHING at ExecStart and the boot-revert (which
lives in the absent binary) can never run; manual `<bin>.previous update
--rollback` on a headless node. Fix: create `.previous` via `linkSync` of the
old binary first, then ONE `rename(tmp, binary)` (safe over a running image;
already assumed at `update-transaction.ts:26-30`). Crash leaves the old binary
bootable and `recordFailure` converges.

### C6. ✅ Retention sweeps: re-probe liveness immediately before unlink (L · S)
Both sweeps snapshot liveness BEFORE the stat/unlink loop (server
`pane-log-hygiene.ts:125-129`; node `pane-log-retention.ts:237-256`; 1-day
default makes it likelier than the server's 30). Interleaving: restart reuses
the same log path append-only with OLD mtime → swept between census and unlink
→ live pane writes an unlinked inode, replay broken until relaunch. Fresh ids
are age-gated; only restart-reuse bites. Fix: per-file liveness re-probe
directly before `unlink`, both files.

### C7. ✅ config.env read-merge-write lost update (L · S-M)
`configure.ts:394 applyConfig` merges against a stale read; dashboard PATCH +
CLI (or two admins) → later rename silently reverts earlier keys while BOTH
audits claim success. Write itself is atomic (tmp+rename 0600). Fix: re-read +
re-merge foreign keys immediately before the rename (last-writer-per-KEY, not
per-file), or flock the config dir.

### C8. ✅ `restoreDatabase` deletes WAL/SHM before the rename (L · S)
`db-backup.ts:289-290` unlinks sidecars, then renames staged→main; crash
between = surviving DB missing its uncheckpointed tail with a then-successful
boot continuing silently (also leaks `<db>.restore-<pid>`). Fix: rename the
main file FIRST, sidecars after, or TRUNCATE-checkpoint before unlinking.

### C9. ✅ WS cookie-fallback: add the `accountDisabled` check (L · S)
`ws/attach-resolve.ts:85-91` trusts `resolveCookieSession` without the
disabled check REST's guard applies (`auth-guard.ts:168-173`). Unreachable
today for THREE independent reasons (disable revokes sessions transactionally;
Elysia doesn't populate the raw request cookie in production; cookieCache
can't spoof it: `session-cookie.ts:51-65` forwards token only), but it is the
ONE principal-resolution path missing the rule. One-line defense-in-depth.

### C10. ✅ CI has no dependency-vulnerability gate (M · S-M)
No `bun audit`/osv-scanner anywhere in `.github/workflows/`; `dependabot.yml`
deliberately skips JS. 26 advisories unwatched TODAY (see C11 for triage:
1 runtime-adjacent, rest dev-tree). Fix: job in `lint.yml` with a committed
ignore file for the dev-only/track set so it passes day one, failing only on
NEW advisories. Rejected alternative (standing): an NPM_TOKEN'd private
registry is not related; keep the OIDC stance.

### C11. ✅ Dead dependencies + audit-fix bumps (L · S)
`ajv@8.20.0` (declared in `packages/subshell-protocol/package.json`, ZERO
imports repo-wide, and pulls `fast-uri`, 7 high host-confusion advisories, into
the dev tree) and `better-auth-ui@3.2.27` (declared in `apps/server/api`,
zero imports, and pulls `@instantdb/react → uuid`). DELETE both, re-run
`bun audit`. Then `bun audit fix`-safe bumps: brace-expansion, browserslist,
glob, js-yaml, minimatch, picomatch, baseline-browser-mapping, babel.
Track-only (crosses majors, upstream pins): `decode-uri-component`
(**mobile runtime** via expo-router → query-string; track upstream, don't
force), `image-size` (metro pins 1.x). Neither reaches a signed desktop/CLI
artifact.

### C12. ✅ Lazy-fetch origin pin, or one §11.12 sentence (L · S)
`releases.ts:662` fetches `browser_download_url` verbatim; a configured
mirror can point the plane's egress at link-local internals (SSRF-probe
class); digest + size cap bound everything else, and Bun fetch can't read
`file:`. Fix: assert `new URL(u).origin` ∈ {configured source, GitHub API
hosts}, or state the egress choice in §11.12 next to "withhold or replay …
and nothing else".

### C13. ✅ Node-local downgrade refusal (defense-in-depth) or docs line (L · S)
`execUpdate` never compares `cmd.version` vs own `NODE_VERSION`; the refusal
lives plane-side only (`update-node.route.ts:268-286`, fails open if a node
never reported a version; impossible at protocol ≥12, so undocumented-edge
only). Fix: one `semverLt` guard in the agent, or a sentence in §11.12.

### C14. ✅ Superseded node socket: identity probe before dispatch (INFO · S)
`handleNodeMessage` live path has no `getLive(nodeId)?.ws === conn` guard
(held path has one); A's queued frames after supersede can rewrite the same
node's fresh facts with stale ones; no privilege crossing, same key,
same node. Optional: `ws.data.nodeConn === getLive(nodeId)` before the switch.

## Operator ruling: RESOLVED (2026-09-24)

### Q1. ✅ Ruled: disabling an account takes its NODES out of service
Verified behavior: disable kills the person's sessions, panes' tokens, and WS
mints, but `node-ws-handler.ts:189-217` never looks at the key owner's
disabled state: their enrolled machines keep connecting and taking LAUNCHES
(their own panes die since tokens mint per-launch for the disabled owner,
but the node stays operational as infrastructure). Docs say "unauthenticated
on both paths" meaning cookie+bearer REST; neither reading says nodes.
Ruling: **(b) HONOR: "2, but in the disable confirm dialog, inform the admin
what will happen."** Shipped same day: upgrade-chain tier refuses a disabled
owner's key (4403 close, pre-socket), the disable route evicts the target's
live AND held node sockets, `local`/system-owned rows unaffected, re-enable
recovers within the agent's 60 s backoff cap, `nodesDisconnected` rides the
audit metadata, and the admin's confirm dialog states the full effect list.

### Round-3 verification
Every item landed red-first with tests; the whole tree re-verified after the
last dependency bump: `verify-types`/`lint:check`/`lint:design`/`test`
(50 tasks)/`turbo build` all exit 0; `bun audit` 26 → 5 advisories, all
allowlisted (`scripts/dep-audit.ignore.json`), gated in CI via the new
`dep-audit` job on `lint.yml`. C8's dispatch premise ("SQLite re-creates
sidecars WAL-less") was DISPROVED by measurement before implementing; a stale
self-consistent WAL replays onto a restored snapshot, so the shipped order is
checkpoint-TRUNCATE before sidecar unlink. Known residue by decision: rows
renamed raw before C1 keep their bytes; operator ruled NO backfill
migration (2026-09-24, "Don't"); pre-users product, settled.

## Resolved: Round 2, 2026-09-23

### R1. ✅ Sign-in and sign-out are audited
`auth.sign_in` (better-auth after-hook, endpoint table; SUCCESS only: a
failed sign-in writes nothing so credential-stuffing can't spam the trail)
and `auth.sign_out` (session-delete DB hook: one row per session ACTUALLY
ended; the `/sign-out` endpoint answers success even when nobody was signed
in, so the row is the proof). Metadata: method (password/passkey) + ids,
never tokens, emails, IPs, or UAs. Break-glass deduped: its
`emergency_login.rewrite_credential` row wins, no parallel sign-in row.
Audit-write failure warn-swallowed; auth never breaks on the trail. §10
rewritten, §12 item satisfied, `audit-log.mdx` fixed. 12 tests incl. a
hand-forged full WebAuthn passkey ceremony. One existing keyset-ledger test
re-sequenced (its fixture's sign-in now lands above its snapshot).

### R2. ✅ Admin Setup-keys UI pinned by tests
Confirmed the original wave's component coverage (switch hidden for non-admins,
`?all=1` fires only after toggle, creator label, foreign DELETE), then added:
hook-level URL-shape pins (`search === "?all=1"`, disabled = zero fetches),
the shared-prefix invalidation proof (ONE invalidate, BOTH list shapes
re-read, revoked row gone from the all-cache), and in-place foreign-revoke
refresh. Mutation-verified non-vacuous. `use-nodes.test.tsx` +
`setup-keys-section.test.tsx`; web suite 1829/0.

### R3. ✅ Retention setter on the node
`GET/PUT /api/self/log-retention` (dashboard) with per-field layer truth
(`env|stored|default` + `forced`), per-field env-force refusal (409 naming the
variable; a combined write touching a forced field stores NOTHING; one status
can't half-report), 400 on junk/empty. Shared setter module
`retention-settings.ts`; the pass re-reads `config.json` hourly so changes go
live without restart; the stated honest limit: a node that BOOTED at `0+0`
scheduled no timer, so leaving keep-forever waits for restart. Node-local
`LogRetentionCard` on Settings (the debug-logging control sits in a
plane-SHARED card, so "beside it" was impossible without a plane twin route
that doesn't exist, recorded). No CLI verb invented: `configure` is
deliberately plane-address-only. Agent suite 749/0.

### R4. ✅ Attach journal: decision recorded
Stays log-only (info line: subshell id, geometry, build, 90-char UA slice into
the 0600 bounded file). Rationale in §10 next to the new auth events: audit is
for ACTS, the log for DIAGNOSTICS; those fields answer real stale-client bugs
and adding an audit row per attach would flood a 50-row reader. `auth.sign_*`
now covers the human half of "who was on".

## Held by decision: Round 2 (open until their trigger arrives)

### R5. Per-IP login backoff behind a gate (M, conditional)
Login backoff is per-email only; under a `public-with-gate` plugin every
request looks like 127.0.0.1. The shape is already prescribed (§8): read
`CF-Connecting-IP` ONLY where the Access guard verified the request, never any
other proxy header. **Trigger: the first genuinely public-gated deployment**;
building it now is dead code defending a scenario nobody runs.

### R6. Re-probe trimmed entitlements under a real Developer ID (S, release-gate)
Both desktop plists were trimmed to `allow-jit` +
`allow-unsigned-executable-memory` measured under AD-HOC signatures; a real
Developer ID + notarization changes what the system validates. **Before the
next desktop cut:** one signed build per app, confirm the bundled Bun binary
boots (failure mode = crash at process start, invisible to local tests).
Release-operator checklist item; needs the CI certificate.

## Deferred by decision (unchanged; re-open only with operator sign-off)

- **Web-push payload carries the subshell display name**
  (`services/notify.service.ts:53`); Expo names nothing. Documented §5.
  **Operator ruled to keep the name, 2026-09-24** ("let's not alter display
  names for web push"); the useful half of a notification wins; settled.
- **Expo relay anonymous** unless `EXPO_PUSH_ACCESS_TOKEN` set. Operator config.
- **5-minute better-auth cookieCache** for copied cookies: library design,
  the one surviving disable asymmetry (§2). **Operator ruled ACCEPT
  (2026-09-24)**; disabling it costs a DB read per request to narrow a
  5-minute window on better-auth-own endpoints that grant nothing in
  Subshell; documented, settled, not a defect.
- **Node loopback dashboard has no credential**: loopback + OS user IS the
  control (§6); `SUBSHELL_DASHBOARD=0` on shared hosts; §12 lists the
  credential as pre-public prerequisite. **Operator declined building one
  (2026-09-24)**; do not resurface unless the dashboard ever stops being
  loopback-only.
- **Instance plugin secrets** (`SUBSHELL_SECRETS_KEY`): designed, NOT built
  (§8); roadmap feature, not a defect. **Operator ruled: no vault until a
  real plugin needs one (2026-09-24, "no until we need it")**; the four
  built-ins deliberately need no reusable stored secret; env/config.env
  remains where plugin-adjacent credentials live. Build only when a shipped
  third-party plugin actually requires it.

## Resolved: Round 1, 2026-09-23 (condensed; full prose in git history)

1. ✅ Disable drops live WebSockets (parity with demotion; close 1012; audited count).
2. ✅ Bearer list enumeration KEPT (operator option A) + pinned by enumerate-ok/act-denied tests.
3. ✅ Node-side pane-log retention: days+hours, env>config>default 1 day, 0+0=forever, unknown-is-not-dead.
4. ✅ Admin setup-key `?all=1` view + revoke; `{foreign:true}` audit; SPA toggle.
5. ✅ Manifest parser refuses sudo/doas/pkexec at ANY shell boundary (basename-exact).
6. ✅ Plugin id-collision refused before the module loads; double-check kept pre-swap.
7. ✅ Backend `assertNodePathId` at all node-path composition sites (leaf module, cycle-aware).
8. ✅ WS attach-token store capped at 10 000 (sweep-then-503).
9. ✅ First-user promotion counts real accounts (shared filter, orphan-row witness).
10. ✅ Node api-key rows carry no permissions map; kind guard recorded as the whole boundary.
