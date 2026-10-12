# The Connect page

The Connect page and SSH launch dialogs use the same connection form and setup
wizard. Users choose a destination, the machine that connects to it, and
optionally another machine whose SSH agent supplies the keys.

Destination suggestions include saved destinations, recent connections, and
aliases from the selected machine’s SSH config. Users can also type a
destination. The server resolves it on the connecting machine before launching.
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
