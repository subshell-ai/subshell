# The Connect page

The Connect page and SSH launch dialogs use the same connection form and setup
wizard. Users choose a destination, the machine that connects to it, and
optionally another machine whose SSH agent supplies the keys.

Destination suggestions include recent connections and
aliases from the selected machine’s SSH config. Users can also type a
destination. The server resolves it on the connecting machine before launching. SSH presets
fill all connection choices and retain the resolved destination when saved;
the original SSH token retains alias-specific routing and key settings. The server
checks every resolved snapshot against the saved canonical destination before
saving a clone, preparing a local key, verifying trust, or launching. Changing
an alias’s destination blocks the connection until the user edits the destination. The preset picker clears any
previous local key selection.

The Presets header’s **New preset** menu offers **New agent preset** and
**New SSH preset** from either tab. Both empty libraries use the shared
`EmptyState` with a type-specific heading and create button. The SSH editor
asks for a name and connection choices, with no description field. Authentication
controls expand beneath their selected radio option: the remote node picker
keeps its accessible label but hides the redundant visible label. Local-key
and password explanations say that credentials are supplied when creating a
new SSH subshell; the preset saves only the authentication preference.
The form displays the server’s refusal and any blocked SSH settings so users
know what to change.

Keep unavailable machines visible with their reason. The setup wizard can
enable SSH when the user has configuration access, or enroll another machine.
Preparing a machine never starts a connection automatically: the user reviews
their choices and selects **Start SSH subshell**.

The destination field uses an input and suggestion panel rather than the shared
combobox. Base UI’s held input loses typed text when its items change on each
keystroke; the working-directory field uses the same approach.

Use **connecting machine** for the machine that runs SSH and **machine supplying
your keys** when explaining the optional remote key source. The code’s
`keyHome` identifier doesn’t need to appear in user-facing explanations. An
**SSH agent** is the program that holds SSH keys, distinct from an AI agent or
the Subshell daemon.
