# The Connect page

Surface doc for `apps/server/web`, spec 2026-10-07 §7 (`/connect`, plan 3).

The page asks one question first: a destination, chosen from the caller's
saved rows, their recent rows, and the picked machine's SSH config aliases -
or typed free, which the list mirrors as its own row until it is committed.
One POST launches: the connecting machine resolves the token on the human's
own SSH config, and the panel renders the server's refusal (the blocked
`settings` list included, read from the parsed body) rather than guessing.

Two UI facts worth keeping deliberate: a machine whose SSH is off stays in
the disclosure greyed with its reason, never hidden (spec 2026-10-07 §4.3);
and the destination field is an input-plus-panel, not the shared combobox,
because Base UI's held input loses typed text when its items swap on every
keystroke (the posture is the working-directory field's, for the same
reason).
