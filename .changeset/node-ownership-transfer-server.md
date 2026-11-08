---
"@internal/server": minor
---

Nodes can change hands. The owner of a machine can now hand it to another account in one step, from the node's page, without the running agent noticing: the link, the credentials, every share, and all running subshells carry on untouched. The dialog offers to keep the giver as a Manage grantee on the machine they gave away (the default), and a handover to a disabled account or a colliding node name is refused before anything moves. Unused re-registration keys die with the transfer, so an old owner's unredeemed recovery key can't pull the machine back. The server's own node stays the instance's, never transferable.

Node sharing grew a third level to match. **Manage** ranks above view and edit and carries the whole owner band of day-to-day control: sharing itself, renaming, maintenance, directory rules, key rotation, repointing, stop and uninstall. What it never buys is ownership: a Manage grantee can't transfer the node, can't delete or re-register it, and file transfers stay the owner's alone.

Automation reaches the same act through a new API key permission, `nodes:transfer`, and a server CLI verb:

```bash
subshell-server node transfer <nodeId> --to <userId> --key-stdin
```

The key comes from stdin and never from the command line, where it would be visible to every local user. A machine credential carrying the grant can only hand over nodes its own account owns, which is exactly the provisioning loop: the server mints setup keys, automation assigns the machines they enroll.
