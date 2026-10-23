# Pane preview: real-leg run log (Step 2 of the Task 14 brief)

This is the manual leg record for the pane-preview feature, run 2026-10-23 on
branch `feat/pane-preview` at base `bb08beac2`. It is NOT CI. The scripts that
drove it live in `/tmp/preview-leg/` (`leg-final.mjs` for the container leg,
`lan-leg.mjs` for the browser leg) with their transcripts beside them, and the
captured frames under `/tmp/preview-leg/frames/`. Where a leg could not run,
it is logged as env-blocked, not as passing.

## What ran

A debian `bookworm-slim` container (tmux, Xvfb, x11vnc, xauth, chromium, bun)
with `--network host` enrolled itself against a leg backend on `:3199` with a
setup key, became node `leg-node`, got `previewEnabled` through the switch,
and launched a terminal pane with `screen: { width: 1280, height: 1024 }`.
Inside the pane, typed over the real input path, ran the brief's bun server on
4123 (body `ok <epoch ms>`, so every load repaints) and a REAL chromium
(`--no-sandbox --disable-gpu --disable-dev-shm-usage
--remote-debugging-port=9222 http://localhost:4123`), which landed headful on
the pane's Xvfb display.

Deviations, stated plainly: the backend and the node daemon ran from source
(`bun`), not from compiled release binaries. Chromium needed `--no-sandbox`
because the container runs it as root. The plane's own HTTP Open leg (cookie
jar, path rewrite) is owned by `e2e/tests/47-preview.spec.ts`, which is green
against a booted stack, so this driver did not re-run it.

## Container leg results (final clean run)

| check | result |
| --- | --- |
| node enrolls, detection finds `terminal`, preview switch arms | PASS |
| pane launch with a virtual display, display allocated (`:98`, rfb 5918) | PASS |
| ports answer `{4123, 9222}` and `cdpPort: 9222` | PASS |
| `POST /preview/watch` | PASS, `{"ok":true}` |
| Watch frames over `/ws/live` | PASS, two `preview-stream` frames (seq 2 to 3, 1050x827), JPEG magic `ffd8ff`, byte-differing, saved to `/tmp/preview-leg/frames/live-0.jpg` and `live-1.jpg`; the frame shows chromium on the display rendering the page's changing timestamp |
| Screen RFB through the raw `/pv` lane | PASS, full handshake (version, None security, ClientInit), ServerInit 1280x1024 `"theo-linux-ai:98"`, 61,456 framebuffer bytes |
| pane close | PASS, `{"ok":true}` |

The RFB client is a hand-rolled state machine in the driver, and two of its
early FAILs were the client's own bugs (RFB servers speak the version first,
and the version string is 12 bytes, not 16). A raw TCP probe beside the lane
agreed with it on the wire, and the browser leg below checked the
viewer through noVNC itself.

## What the Watch leg actually proved, and one real finding

CDP pushes `Page.screencastFrame` only on visible repaints. The first failed
runs of this driver emitted zero frames everywhere, and the cause was the
environment, not the product: because the container shares the host's network
namespace, a bun server orphaned by an earlier pane kept holding port 4123
(background jobs survive their pane's close), the newly typed server died on
`EADDRINUSE`, and chromium kept loading the OLD server's static page. Same
bytes every load, no visible repaint, so chromium legitimately emitted no
frames for anyone. A matrix run (direct CDP client with no bridge, with the
node's bridge watching, and a second client from inside the container) showed
three events on every side once the page truly repainted, which is also proof
that CDP screencast is multi-session: the bridge's session and an outside
observer coexist. The fix was a pre-clean plus a typed-server alive check
(`docker exec pgrep`, retype up to four times), and the run above is that
clean pass.

Two more honest notes from this leg:

- The bridge's very first frame (seq 1) was emitted between the watch POST and
  the `/ws/live` socket attaching, and the plane drops frames with no
  subscribers. That is by design; the leg therefore asserts on frames 2 and 3
  and says so.
- A typed screencast window before the watch occasionally hit a CDP
  `-32000 Not attached to an active page` refusal while the reload driver was
  mid-navigation. Retries see the events; it never affected a recorded result.

## Typed-input observation (product-adjacent)

Container bash (no line editor) corrupted submitted input several times:
adjacent duplicated characters landed in the command line (`TextxtEncoder`,
`typext/plain`). Every leg script now verifies its typed server actually
started before trusting the input path. It reproduced on plain shell panes
only, in this container; whether plain bash's lack of a line editor makes it
more exposed than an editor-backed shell is untested here and worth a ticket
separate from this feature.

## Display lifetime (expected, logged so the next reader doesn't file it)

Deleting a pane through the API does not itself tear down its Xvfb/x11vnc
pair. Teardown rides the pane's own exit report, and the backstop for deleted
panes is the node's periodic display sweep, which reaps a display only after
it has been absent from a complete pane census for its floor. Orphaned
displays minutes after `DELETE` are the design, not a leak.

## LAN http-origin leg (browser, the rfb.js secure-context question)

A Playwright headless chromium drove the real SPA at
`http://172.16.1.197:3199`, a plain-http LAN address. Result: ALL-PASS.

- `window.isSecureContext` is `false` there, as expected for http off
  localhost.
- Sign-in through the browser context, pane route, Preview section, click
  `Screen`: the raw lane WebSocket completed the RFB handshake and noVNC's
  canvas carried native 1280x1024 dimensions (which only ServerInit sets),
  with no close line and a live frame still standing after three seconds.
  Screenshot: `/tmp/preview-leg/frames/lan-screen.png`.
- noVNC's `rfb.js` logs exactly the warning the brief pointed at:
  `noVNC requires a secure context (TLS). Expect crashes!` It fired once per
  mount and was harmless here: our lane speaks RFB with None security over
  the plane's own socket, and nothing on that path needs a secure-context
  API. So the browser sees a console error on a LAN-http Screen session that
  works. Whether to demote that line for our configuration is a small
  follow-up judgement call, not a defect in this feature.
- Incidentals: the fresh leg backend sits behind its first-run wizard, so the
  leg walked it like an operator (Network, tmux, Agent, Start-or-Skip). That
  is the product working, noted only so the transcript makes sense.

## Mac leg: ENV-BLOCKED

No reachable enrolled mac exists. The leg backend's fleet is the linux
control-plane host plus the linux container node; the one mac on the network
is a build runner whose Subshell install was removed in 2026-09, and installing
a node daemon on someone's machine is outside this task. The mac half of the
Screen story (no Xvfb, so a display request answers with its named refusal) is
covered by the earlier tasks' unit matrix, but it was NOT re-proven on real mac
hardware here, and this log records that as env-blocked rather than passing.

## Teardown

The container was removed (`docker rm -f subshell-preview-leg`, leaving
`subshell-ssh-demo` alone), the leg backend was killed and `:3199`/`:3200`
verified free, and the leg's tmux sockets swept, before the package boundary
suite ran.
