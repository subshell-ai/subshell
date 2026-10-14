---
"@internal/server": major
"@internal/node": major
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Open SSH terminals from the subshell launch dialog using local keys, a jump host, or selected SSH-agent keys on another accessible machine. The connection form supports key and password authentication and enables outgoing SSH when the node’s owner starts a connection. Saved destinations, workspace launches, view-only access, and destination enrollment share the same flow.

Encrypted agent relays keep private keys on their home machine and restrict signing to the selected fingerprints. Existing machine launch access authorizes both ends; there are no separate SSH grants or approval requests. Host keys and machine identities stay pinned, and changing them requires explicit recovery. The server can participate as either relay endpoint. Unfamiliar relay destinations ask for confirmation in the connection flow; users no longer need to paste or manage host keys in settings.

Update the server before the nodes. This feature requires node protocol 20. SSH stays disabled by default on each machine. Migrations add the SSH capability, saved destinations, and trust records; migration 0053 removes obsolete grant and approval tables while preserving destination trust and audit history.
