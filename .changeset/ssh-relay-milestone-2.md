---
"@internal/server": major
"@internal/node": major
---

Connect an SSH terminal using selected keys from another machine's SSH agent. Existing machine launch access is required on both machines; there are no separate SSH grants or approval requests. The relay encrypts agent requests between machines, limits identities and signing to the session's selected fingerprints, and never transfers private keys.

Destination host keys and both machine identity keys remain pinned. Changed keys require explicit recovery. Relays close when launch access is removed, and "Set up Subshell here" preserves the original key selection while enrolling the destination without showing the setup key in the terminal.

Update the server before the nodes. This feature requires node protocol 19 and Subshell node 1.5.0 or later. Migration 0053 removes the obsolete SSH grant and approval tables while preserving saved destinations, host trust and audit history.
