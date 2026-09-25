# Maintenance: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## Maintenance (`src/maintenance.ts`, spec 2026-09-14)

One flag, `<dataDir>/maintenance.json` = `{ on, changedAt }`, meaning "this
machine stays enrolled and answers everything, but takes no new subshells". It
is settable from either end (the plane's `set_maintenance` command and this
machine's own `subshell maintenance` verb), and the two copies are reconciled
on reconnect by the NEWER `changedAt`, which is why every writer here stores
the stamp it was GIVEN and never re-stamps a value it is merely relaying.

**Its own file, not a field in `config.json`.** `config.json` is snapshotted at
daemon boot, so a value there would not reach a running daemon until it
restarted, and the point of the CLI verb is that the person at the keyboard
flips it under a live node. It is also the node key's only home, and a value
flipped several times a day does not belong in the file whose every rewrite
risks the machine's credential.

**The read is fail-CLOSED, deliberately unlike `allowed-dirs.json` beside it.**
An unreadable allowlist widens the node to unrestricted, because that list is a
restriction an owner opts into and a disk hiccup must not brick every launch.
Here it inverts: a refusal that fails open is not a refusal, so an unreadable
file refuses every launch and `maintenance status` says exactly that instead of
reporting a tidy "off". An ABSENT file is the third answer and is not
fail-closed: a node that was never told anything behaves as it always did.
Absence also travels differently from `{ on: false }`: `ready` omits the field
entirely, so the plane's own row wins outright rather than tying with a stamp
nobody wrote.

**The reporting ORDER is load-bearing.** `maybeReportMaintenance` runs inside
`reportDeath` BEFORE the `exit` frame, not only on the heartbeat. The plane
serialises frames per socket, so the flag landing ahead of the first death is
the difference between "the operator took this machine down" and N crashes the
plane pushes as failures and tries to auto-restart onto a node that refuses
launches. The heartbeat call is the belt for the other case: a flip with no
panes running, where nothing dies to carry it. Anything that reorders
`report.ts` has to re-check this.

The refusal a launch answers with is the BARE `NODE_RESULT_MAINTENANCE`
constant: the plane compares `detail` by equality, so a suffix, however
helpful, reads there as an ordinary launch failure. The event that rides with
it is what lets the plane converge from a refusal it did not expect.

**An unreadable file is REPORTED too, as the `on` it actually produces**, under
the FILE'S OWN mtime. Reporting nothing there was a permanent disagreement in
the common case of a node the plane never flagged: with no row of its own the
plane has nothing to reconcile, so it keeps the node launchable while every
create 409s, and neither side ever rewrites the file. Reported, the plane
adopts it and the operator's "off" in the browser pushes a clean
`set_maintenance`, which is the thing that actually repairs this machine. The
mtime rather than `now` because it is the one timestamp nobody invented, and
because it is STABLE: a fresh stamp per read would defeat the report memo and
put one frame on the wire per heartbeat forever. Only a file this process could
not even stat refuses silently: there is then nothing truthful to send.

**A mirror DELETED under a live connection is rewritten from the memo.** The
plane holds what this socket last told it and the machine now reads "absent ⇒
off", and nothing reports the gap because absence has no stamp to send; the
memo is by definition that agreed value, so writing it back restores what the
plane's own reconnect push would have. Only for absence: an unreadable file is
reportable on its own terms, and overwriting it would destroy evidence.
Hand-deleting the file is not an interface; `subshell maintenance off` is.

A restore that FAILS (a read-only disk, a path nothing can create) is retried
every tick and logged ONCE per connection. The retry is cheap and succeeds the
instant the disk returns; the line is capped because the heartbeat is 15 s, so
an ungated failure writes four lines a minute into one 200 KB file that is
REPLACED when full, about six truncations a day, discarding exactly the log
an operator is going to read about this machine. `seedMaintenanceMemo` seeds
that flag together with the memo, so a reconnect says it once more.

`maintenance status` reports the mtime for an unreadable file too, with
`file: "unreadable"` as the discriminator saying where the stamp came from: a
`null` there beside a node page showing the mtime is two answers for one file,
read by whoever is mid-incident comparing the two.

The CLI's `on` never forgets a meta record for a pane it kills. With no daemon
running those records are the only thing the reconnect census can report;
dropping one would leave the plane holding a `running` row with nothing on this
machine able to contradict it. It also RE-PROBES after each kill rather than
assuming it worked: `killSubshell` is synchronous and swallows its own errors,
so `stopped` counts only what the socket confirmed gone and anything still
alive is named on stderr. The exit stays 0: the flag is written and the
machine launches nothing either way.
