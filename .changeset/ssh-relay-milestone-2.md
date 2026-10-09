---
"@internal/server": major
"@internal/node": major
"@internal/subshell-protocol": major
"@internal/pane-runtime": major
"@internal/server-web": major
"@internal/node-web": major
"@internal/node-admin": major
"@internal/backend-errors": major
"@internal/mobile": major
---

SSH sealed agent relay (milestone 2): a machine that holds no keys can open an SSH-terminal pane anywhere its operator's key home can reach. The connecting machine's node binds a per-pane ssh-agent proxy socket (the pane's scoped `SSH_AUTH_SOCK`, unbound at teardown); every agent request is sealed machine-to-machine over the plane, which brokers the pairing and routes opaque envelopes by a routing ref and nothing else. The key home's responder probes the live agent's numbering (OpenSSH classic vs RFC 9987, learned per session, never assumed), forwards only `REQUEST_IDENTITIES` and `SIGN_REQUEST`, and scopes both to the grant's selected fingerprints. Origin rides an ES256 signature inside the sealed envelope; endpoint-contributed nonces and a monotonic per-direction sequence make every relayed byte replay-inert. Grants (`ssh_key_grants`) bind a key home to a destination selector; the first use of a new pair asks the key home's owner to approve (a durable `ssh_grant_requests` row plus an owner notification, a loud fail-fast refusal, never a hung pane), the approval records the chosen public fingerprints and captures the destination's host-key pin from the key home's own `known_hosts`, and revocation is instant both ways. Panes verify D against a per-session pinned `known_hosts` delivered on the signed relay-open (`StrictHostKeyChecking yes`, system-wide file disabled); a changed destination host key is a hard block and delete-plus-fresh-capture is the operator's TOFU recovery. Machine identity: every agent node carries an ES256 signing keypair reported at enroll, peers pin each other's signing AND encryption halves byte-equal in a store separate from channel pins, and the node's loopback dashboard and the machine trust card show the fingerprints for the out-of-band comparison. "Set up Subshell here" turns an open pane's destination into an enrolled node by driving the ordinary install one-liner over a separate non-interactive ssh exec, so the minted setup key never reaches the pane screen or its log; an installer line carrying a key is redacted twice over. The grants screen, the destination trust screen, and the launcher's key-home picker complete the surface.

Deployment: update the server before the nodes. The link gate is exact-match at protocol 18, so an agent that has not crossed the bump is held and takes no relay traffic. Migrations 0049 through 0052 add the signing-key slots, the grants, the pending-approval rows, the host-key pins, and the pane's key-home column; never run them against a live database without a full archive. Nothing changes for anyone until a node's SSH gate is enabled and a launch names a key home.

Proof: e2e spec 23 (the crown jewel) drives the whole path against a real `ssh-agent`, a real `sshd`, real node daemons, and the real broker, with a plane-side capture asserting only opaque envelopes cross, and the 10.x numbering, the fingerprint scope, the revoke cut, the lifetime cap, the setup-key redaction, and the changed-host-key block plus TOFU recovery all asserted end to end.
