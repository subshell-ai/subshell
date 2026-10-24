---
"@internal/server": patch
"@internal/node": patch
---

SSH destinations whose config sets `SendEnv` or `SetEnv` now connect instead of failing with an unsupported-setting error. Ubuntu's default `/etc/ssh/ssh_config` ships `SendEnv LANG LC_*`, so every default-configured machine was refused over a setting Subshell never carries anyway: environment never rides a Subshell SSH link. These settings are now dropped at normalization; everything that could change what a connection is (ProxyCommand, tunnels, forwards, remote/local commands) still refuses by name.
