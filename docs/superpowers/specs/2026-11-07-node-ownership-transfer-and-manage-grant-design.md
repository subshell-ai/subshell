# Node ownership transfer and the `manage` share level

Date: 2026-11-07. Decided with the operator the same day; implemented from this
spec. Plan file companion: `~/.claude/plans/review-the-plan-foamy-duckling.md`.

## The two features, in one line each

A node owner can hand their machine to another account in one audited act, and
node sharing gains a third level, `manage`, that carries the whole owner-only
band without touching the owner-exclusive floor.

## Decisions the operator made

- **Direct handover, not an invitation.** Owner picks a user, confirms, done. The
  fleet is known people on a trusted network; an accept ceremony was twice the
  machinery for a surprise we instead disclose in the confirm dialog.
- **The level is called `manage`, not `admin`.** "Admin" already names the
  instance role (the vocabulary rule: no word names two things), and the
  2026-10-09 ruling just spent effort cutting admin reach. `manage` names the
  gate it confers, which the code already calls `canManage`.
- **Ceiling.** `manage` confers everything that sits on the `canManage` gate
  plus the two strict-owner arms that were above it (repointing; service
  stop/uninstall). It does NOT confer: ownership transfer, node DELETE or
  re-register (the `canRetire` gate, owner or any instance admin, unchanged),
  or file transfers (strict owner on both ends, unchanged, because
  `docs/security.md` accepts that surface precisely as an owner-only one).
- **`manage` is refused on `local`.** The control-plane host has no human owner;
  the decision of who manages that machine has always belonged to admins alone.
  The shares route refuses the level on the local row with a 400.
- **Everyone may carry `manage` on an agent node (operator ruling,
  2026-11-07).** The Everyone row is an ordinary share, and one manage row on it
  arms every signed-in account with the band on that machine. That is the
  owner's explicit act, so the route allows it and the sharing procedure states
  the consequence loudly; it is not an oversight to "fix" with a refusal.
- **Share-back by default.** The transfer confirm dialog carries a checked
  "Keep managing it yourself" option; in the same transaction the old owner is
  upserted as a `manage` grantee. Losing your own machine mid-operation was the
  footgun; automation and CLI callers pass the flag explicitly.
- **Machine access is explicit and narrow (added at review).** A new API-key
  grant `nodes:transfer`, an MCP tool `transfer_node`, and a server CLI verb
  `subshell-server node transfer`. A system key holding the grant reaches only
  nodes the system account owns (the provisioning story: server-minted setup
  keys produce system-owned rows, automation assigns them). A pane token can
  call the route only through inherited explicit grants, so an ordinary
  human-launched pane reads the 403 and stays out of ownership acts.

## What a transfer moves and what it leaves

The owner tie on a node row is exactly `nodes.ownerUserId`, so the transaction
is small; everything else here is a boundary someone could get wrong:

| fact | after transfer | why |
| --- | --- | --- |
| link and credentials | unchanged, no socket eviction | `/ws/node` binds `node.apiKeyId === key.id` and metadata; it never compares the key's user to the node owner |
| bearer apikey row | `"referenceId"` re-homed to the new owner | that column (not `userId`) is the physical owner; re-homing keeps key lifecycle management with whoever owns the machine. Account-disable semantics follow `node.ownerUserId`, so they flip to the new owner by intent. The transfer and the rotation CAS on the same pair, `(owner_user_id, api_key_id)`, so whichever commits second loses with a 409 refresh-and-retry, and no ordering of the two commits a node whose live key belongs to someone other than its owner (security pass on #495; round 2 added the owner to the rotation's key-only CAS, closing the rotate-after-transfer direction the transfer's key-inclusive CAS alone left open) |
| shares | kept as-is except the giver's own prior row, which is deleted first; exactly one `manage` row is inserted when share-back is on | the re-registration precedent: "keeps its name, shares, and settings" |
| live relays through the machine | authorization sweep after commit (`closeUnauthorizedForNode`) closes relays the changed access no longer authorizes | a clean-break giver must not keep streaming through a machine they handed over |
| unused recovery keys targeting the node | deleted | they're stored under the old owner and redemption compares the node owner to the key owner, so left behind they'd be dead weight the old owner's UI still lists (rotate-key does the same delete) |
| used recovery keys, audit history | untouched | history is history |
| running subshells and their tokens | untouched | pane tokens bind to the pane's creator; nothing watches `nodes.ownerUserId` at runtime |
| name uniqueness | collision refused inside the transaction (the UNIQUE violation rolls the swap back) and answered 409 | `idx_nodes_owner_name` is UNIQUE per owner; the remedy sentence says rename first |
| recipient checks | unknown, self, disabled, or approval-pending recipient all 400 | handing a node into an account that cannot sign in is the fake success this house refuses; a disabled owner's nodes are offline by ruling. The transaction re-asserts the recipient's standing at commit time, so a disable or approval landing mid-request is a 400 and nothing moves (security pass on #495) |
| `local` | 400 before any permission check, for every actor whose gate resolves (admins always; other accounts while a launch grant stands) | route-shape-before-caller, the service/repoint ordering preserved. An actor who cannot see `local` (its seeded Everyone grant turned off) or a machine credential hits the invisible 404 at the gate first, like any other unseen node |

Audit: one new event, `node.owner_transfer`, metadata `{fromUserId, toUserId,
retainAccessAsManager}`, ids only. No live-bus announce: `node.changed` is
dropped by the publisher and has never been produced in production; the SPA
invalidates its own queries after the mutation, the same posture as the shares
route.

## Where `manage` lands in the ladder

```
none < view < edit < manage < owner          (grants: view|edit|manage)
delete / re-register: owner OR any admin     (canRetire, unchanged)
transfer: owner, or a credential explicitly granted nodes:transfer
```

Three code facts make the level cheap, and one makes it dangerous:

- `node_shares.permission` is TEXT with no CHECK, so no migration; validation
  is the TS union plus the node-private wire schema in `node-view.ts` (the
  shared `models.ts` union feeds subshell and preset routes and must not move).
- Both `get-node` extras and `PUT /api/nodes/:id/update` ride
  `nodeCanConfigure`, so a manage grantee reads runtime/daemon-log surfaces and
  runs the update card on an ONLINE agent node with no extra work.
- `nodeCanManageFor` is the single admin-on-`local` exception; `node-view.ts`
  and `gate.ts` both derive `canManage` from it, so view and gate cannot drift.
- **`nodeCanRetire` today calls `nodeCanManage`** (`access.ts:167`). Once
  `nodeCanManage` admits manage, an unchanged `nodeCanRetire` hands DELETE and
  RE-REGISTER to every manage grantee. It is rewritten to ask for the owner
  rank directly, and a pure resolver test pins `nodeCanRetire(manage, false)
  === false` as the creep pin.

The hidden one: `repairMachinePin` re-checks owner equality inside the service
(`ssh-machine-pins.service.ts:93-94`) after its route passes on `canManage`;
left alone, a manage grantee walks through the door and gets refused inside it.
Widened to match.

## Files that carry the change

Server: `api-key-permissions.ts` (grant), `node-shares.db-types.ts`,
`modules/nodes/access.ts` (ranks + the retire decoupling), `node-view.ts`
(both enums + `canTransfer`), `set-node-shares.route.ts` (local refusal), new
`transfer-node.route.ts` + `modules/nodes/transfer-ownership.ts`,
`apikey-store.ts` (`setApiKeyOwner`), the two strict-owner route arms, the
ssh-machine-pins service arm. Clients: `packages/node-admin` (mirror types),
`sharing-dialog-core` (levels prop), node sharing/transfer dialogs, mobile type
mirror. `packages/mcp-core` gains `transfer_node`. `apps/server/api/src/cli`
gains the `node transfer` verb.

Docs that must agree: this spec, `docs/security.md` §2/§3/§6/§10,
`apps/server/api/AGENTS.md` (share axes, retire-vs-manage, audit inventory,
transfer bullet), `.claude/rules/security-context.md`, the user docs nodes
pages.
