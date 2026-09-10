---
"@internal/server": minor
---

**Registry-installed plugins now launch.** Until this cut the instance's plugin door sold installs it could not honour: a third-party plugin listed, toggled and uninstalled through `Settings → Plugins`, but every launch-path lookup (the detect rules the plane ships to nodes, profile validation, argv assembly) keyed off the plugins compiled into the server binary. A profile create for an installed plugin answered `Unknown harness`, and its node rows stayed "not detected".

The control plane now resolves its own plugin store: at boot, and after every install and uninstall, it loads the bytes in `<data-dir>/plugins/` through the same loader the built-ins use, and the launch path answers from that merged view. A just-installed plugin is launchable the moment the install response lands; an uninstall stops resolving the moment it completes.

Built-in ids are unchanged: the copy compiled into this build answers for them. A registry package that takes a built-in's id is named in the server log once and not loaded; the seeded built-in copies the store itself holds stay silent.
