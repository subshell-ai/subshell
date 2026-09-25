# Reset: the full account

Moved from `apps/client/desktop/AGENTS.md`, which keeps the operational
summary and routes here. The text below is verbatim.

## Reset: returning this machine to un-enrolled

`src-tauri/src/reset.rs`, and the shape is `apps/server/desktop`'s deliberately:
**the page supplies a hostname, never a path.**

`node_arm_reset` reads the machine NOW and stashes a delete plan parsed from the
node's own `subshell status --json` `paths` block; `node_reset` deletes exactly
that, gated on the typed hostname. The plan is stashed at press time rather than
re-read inside the chain because the chain UNINSTALLS the very node whose
report names those paths; re-reading afterwards would be asking a removed
binary where its own data lived.

- **All-or-nothing.** Every one of `configFile`, `lockFile`, `dataDir` present,
  non-empty and absolute, or there is no plan. A status with no `paths` key at
  all is the not-enrolled case (the CLI omits the block when no config loaded),
  and the screen renders its own refusal rather than offering a button.
- **config.json is deleted LAST.** It is what makes this machine a node, so
  while it survives the reset is resumable: a half-run that died after the data
  dir still has the config the next attempt reads its plan from. `deletion_order`
  is a pure function returning a `Vec<PathBuf>` precisely so that property is a
  test rather than something only a real wipe would show.
- **The guards are the shared ones** in `subshell_desktop_core::reset_guards`:
  `path_rules_ok`, `delete_guard_ok`, `is_subshell_socket`, `consent_granted`,
  and `machine_hostname`, which moved there in 2026-09-12 when this chain
  needed it, because it is the value `consent_granted` compares against and two
  copies of a fail-closed rule is one copy that can drift open.
- **The probe reports the hostname so the screen can SHOW it.** The gate is
  deliberate consent, not a memory test, and a box demanding a string the page
  cannot display would be both. An empty memo (hostname(1) would not run) is
  refused by name: the empty box it would otherwise match is the one thing
  this gate may never accept.
- **Three paths, not the server's five, and NO window dance.** That app has one
  manage window and a zero-window moment quits it; resetting a node here
  invalidates neither of this app's windows, and the page's own re-probe lands
  it on Enroll.
- **`planeUrl` is KEPT.** The control plane this person watches is not what they
  reset; making them retype its address to get their dashboard back would be
  the reset reaching past what it promised.
- **Channel discipline:** `Err` only for refusals BEFORE the first mutation. A
  half-run is `Ok(ActionResult { ok: false })` with the verbatim log and the
  plan still stashed, so a Retry converges.

What it deliberately does not reach is on the screen, because each is something
a person would assume it handled: the control plane keeps a node row (now
permanently offline, for its owner to delete there), the installed
`~/.local/bin/subshell` stays (the containment guard refuses any delete that
would take it), and a Subshell Server on the same machine is untouched.
