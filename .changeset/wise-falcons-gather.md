---
"@internal/server": minor
---

The sidebar's subshell list is grouped by the machine each subshell runs on.

Every group carries a header with the node's own NAME, a count and a chevron;
collapsing one is remembered per device, keyed by node id so a rename cannot
reopen a group you shut. Groups sort by their liveliest member, so a machine
with something waiting for you stays on top, and the eight-row cap applies per
node rather than across the whole list — one machine's pile of ended sessions
can no longer crowd out another machine's live work. While the filter box has
text every group renders open, whatever the device remembers: a match hidden
inside a shut group reads as a filter that does not work.

Hovering a row names the three things the row itself cannot say — the node, the
agent, and the state — and reveals in full the two it has no width for: the name
and the working directory, both truncated at rail width, which the pre-grouping
tooltip existed to show.

The subshell page's status badge is gone; the state is a dot beside the name.
It renders the SHARED indicator (working / idle / waiting for you / exited /
node unreachable / ended), so the page, the rail and the home card can no
longer say three different things about one subshell — the header used to
carry its own copy of the offline-outranks-exited rule and spelled the raw
lifecycle status instead.
