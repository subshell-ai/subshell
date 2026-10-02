# Native backup and restore constraints

The assistant's requested `backup` and `restore` screens are bundled and must
work before initialization and with the server stopped. User procedures live in
[the administration backup guide](../../../docs/content/docs/administration/backups.mdx).

`src-tauri/src/backup_restore.rs` delegates archive parsing, encryption,
preparation, replacement and installed-service ownership to the server CLI.
Native code never implements a second archive engine or service identity proof.
Only `wizard` owns the six operation commands and the save/open picker grants;
`main` may request a closed screen word through its existing assistant command.
The exact capability, permission-manifest and caller-set tests pin this split.

A restore inspection and protected prepared stage validate choices, destination,
expiry and administrator recovery before native supervision stops. Prepared
mode, address and recovery choices remain authoritative. Replacement and pane
interruption are separate unticked consents. An app-owned supervisor requires
pane consent before pausing its current desired-running child, including a
respawn gap. Update, reset, service and restore share the exclusive action gate.
Native `--native-preflight` reuses the CLI's independent loaded service proof
before the app child is stopped; staged `--native` repeats it at application.
An installed service must use the exact prepared config, database and data
paths even when Start is unchecked. Ordinary CLI `--no-start` remains available
for a separate offline destination. Installed services are stopped/started only
by the CLI's proved manager chain;
no restore installs a binary, service definition or login policy.

`RestoreLocation` persists the chosen configuration directory, exact database
and data paths, and the database-only distinction in the app's own 0600
`restore-location.json`, written atomically. It contains no authentication or
address values. This is needed for a legacy archive: restoring the database
must not rewrite config.env, but a later ordinary Start and app reopen must
still select the validated destination. Boot activates this selection before
probing, and `control::server_spawner` reads the same record for every start.

A restored `ServerSpawner` clears inherited supported configuration, emergency,
test and supervisor environment before setting its own supervisor claims. Full
restores read the newly restored config.env in its configuration directory;
legacy restores additionally pass their exact database/data paths. The supported
key list is pinned against the CLI's archive contract. A matching boot rollback
restores prior native environment, metadata, binary and supervision selection.
A no-start result deliberately retains the new selection and stays stopped,
including when the app reopens.

`restore-selection.json` records previous/next location, binary and supervision,
the prepared-stage/engine UUID, expected journal/receipt paths and native phase
before application or changing active choices. It contains no prior environment
or credentials. Metadata uses a private directory and exclusive 0600 temporary
file, file fsync, rename and parent fsync. The initial process environment is
captured before restored activation; rollback adopts that transient snapshot or
the prior location policy. Matching receipts reconcile on immediate apply,
ordinary Start, probe/watch and cold boot. Missing/stale/invalid receipts or
metadata failures retain the transaction and block automatic start. Rollback
stops the failed child before restoring durable choices. A restore child gets
one boot attempt; normal respawning resumes only after matching completion.
No-start reopening never chooses Start implicitly.

Native success requires a bounded wait for the exact transaction's `completed`
receipt. A running process, reachable HTTP port or absent journal is insufficient.
A rollback receipt reports the previous-state fact. Pending-journal errors leave
the supervisor stopped so an old executable cannot respawn over replacement
state. Passwords use exclusively created 0600 temporary files with RAII cleanup,
never command arguments. Password and temporary-password limits count UTF-16
units to match JavaScript/CLI (1–4096, with temporary minimum8), with one-line
CR/LF/NUL refusal and at most16384 UTF-8 transport bytes. Failure output is
redacted. Successful responses are projected through bounded, typed public
backup/inspection/stage/apply schemas; no unknown fields cross IPC. An unknown
field echoing an entered secret withholds the whole result. Public metadata
such as `database/instance.db` or an administrator name remains valid even when
it matches a password; guessing secret leakage from public substrings is not
a privacy boundary. Full backup hints explicitly include supported config and
plugin-owned secrets, with external agent credentials/project/upload/remote/OS
state exclusions.

The UI regression suite exercises requested doors, defaults, stage retention,
legacy transitions, inspect-before-apply and independent consents. Rust tests
exercise actual owned child environment, persisted legacy later-start/reopen,
rollback environment in an isolated process, receipt matching and password
transport cleanup. Use the root `rust:check` script for native verification;
it stages only the necessary missing sidecar stubs. Never exercise these actions
against the live server or installed service as a scripted smoke test.
