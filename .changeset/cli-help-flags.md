---
"@internal/server": patch
"@internal/docs": patch
---

`subshell-server --help` printed nothing and BOOTED the server (any leading flag was the service-manager boot form). `--help`/`-h`/`help` now print the usage text and `--version`/`-v` print the version, all exit 0, none boot; every other leading flag keeps the boot contract untouched.
