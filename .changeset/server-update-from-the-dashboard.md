---
"@internal/server": minor
---

An admin updates the server from the dashboard, and sees the whole instance's versions in one place

**Server Settings → Updates** is a new page: what this server is running, what
it could be running, one press to change it, and — beside it — every enrolled
node and both desktop apps.

The Server card is the one with a button. It runs the same steps
`subshell-server update` runs, in this process: download the release asset,
verify the digest the same release published, prove the binary says what it is,
back up the database, swap with two `rename(2)`s, and exit for the service
manager. The page follows the job by phase (downloading with its byte count,
verifying, backing up, installing, restarting), then waits for the server to
come back — and it is the RETURN that decides the outcome, not the swap: the
new binary either completes the transaction at boot or reverts it, and the page
reports "the update to 0.7.0 failed and 0.6.0 was restored" when it reverted.

What it refuses is most of what it does. `POST /api/admin/server/update` is
cookie-admin only, bearer keys refused, audited with the admin as actor before
anything starts, and answers 409 for each of: no release source configured,
nothing supervising this process, a checkout or an unwritable binary, a
transaction already open (including one a `subshell-server update` opened in a
terminal), no newer release, a downgrade, and a service definition that would
close every running subshell — the last being the only one a press can
override, exactly as the restart dialog's forced path does.

`GET /api/admin/updates` answers the whole page in one read, so the three cards
cannot disagree about which release list they saw. Node rows report their
version, platform triple and state; updating one from here arrives with the
node half of this work, and until then every row says so rather than offering a
button that does nothing.

The bundled-server offer that lived on Server Settings → Service has moved here
as a line inside the Server card. "This app ships a newer server" and "the
release source has a newer server" are two answers to one question, and on two
pages a person had to choose which to believe.
