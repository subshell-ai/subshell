---
"@internal/server": minor
---

SSH connections can carry port forwards you declare: local (`-L`), remote (`-R`), and dynamic SOCKS (`-D`) rows in the connection form and in SSH presets. Forwards bind the connecting node's loopback address unless its owner turns on **Allow wide port forwards** on the node's SSH card, and a remote forward's bind answers to the destination's own SSH server policy. A forward opens with the subshell and closes when it ends. Forwards that came from the connecting account's SSH configuration files are still refused by name; only rows declared at launch open a port.
