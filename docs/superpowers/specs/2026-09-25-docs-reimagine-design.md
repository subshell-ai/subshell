# Docs re-imagine

Date: 2026-09-25. Branch: `docs/reimagine`. Status: approved direction,
executing. Replaces the closed `docs/digestibility-rewrite` PR.

## What and why

Two prior attempts failed for opposite reasons: the first restructured but in a
performative voice the operator rejected outright; the second fixed the voice
but froze the page set, so it read as a rewording. This is the re-imagined
site: a new architecture in the Tailscale/NetBird mold (a taught start path,
one task per page, per-platform installs, a Concepts/Reference split, short
pages), written from scratch in the approved voice, with the operator's opener
rule (a page begins with one plain sentence that says what it does).

The voice lives in `apps/docs/STYLE.md`; its opener rule and calibration are
the operator's, demonstrated on the approved "Install on Linux" page. Facts are
not re-derived: today's 72 pages (audited accurate) are the fact bank. The map
below names, for every new page, the old page(s) its content comes from. That
mapping is the fidelity contract: an auditor diffs each new page against its
named sources and the code, so "from scratch" cannot quietly drop a caveat or
invent a flag.

## Decisions

- URLs break freely; the docs are young and single-operator (operator ruling).
- Old pages are retired as their content lands in new homes; nothing is deleted
  until the destination carries it.
- Reference CLIs stay one page per binary (a command table up top, one H2 per
  verb) rather than ~18 stub pages: at ten verbs each, separate pages add nav
  noise, not digestibility. This is a deliberate deviation from "split every
  big page by command," made by the writer, and reversible if the operator
  disagrees.
- Page count lands near the current 72 (shorter pages, more boundaries), not a
  token "60". Digestibility is bounded scope per page, not a low page count.

## The architecture (new sidebar, root meta order)

index, get-started, use, agents, nodes, server, automation, concepts,
reference, help, develop.

## Content map: every new page -> its source(s)

Legend: NEW = page did not exist before; MOVE = content relocates;
SPLIT = one old page becomes several; MERGE = several become one; a plain row
means rewrite-in-place (new opener + voice, same scope).

### Home
- `index.mdx` (Home) - SPLIT-from index + about/index + get-started/index.
  Route by intent in a table; the three words in three lines; no feature tour.
  What-Subshell-is prose moves to concepts/index.

### get-started - a taught path, six ordered pages
- `index.mdx` "Get started" (NEW spine intro) - from get-started/index
  (quickstart) + about/index "what it gives you". The ordered path and one
  Prerequisites block.
- `install-linux.mdx` "Install on Linux" (NEW) - SPLIT from get-started/
  install-server (one-liner + init) and server/headless-install. The approved
  sample page is the reference implementation.
- `install-macos.mdx` "Install on macOS" (NEW) - SPLIT from get-started/
  install-server (script + the desktop-app GUI path).
- `first-subshell.mdx` "Your first subshell" - from get-started/first-subshell
  + quickstart steps 2-4 (admin, tmux + agent, launch, terminal, close).
- `from-phone.mdx` "Pick it up from your phone" (NEW) - happy path from
  get-started/mobile + use/notifications + use/devices + quickstart step 5.
- `add-a-machine.mdx` "Add another machine" (NEW) - happy path from
  nodes/add-node + nodes/client-as-node. Pointer into /nodes for the rest.

### use - daily work (rewrite; one new overview)
- `index.mdx` "Use Subshell overview" (NEW router).
- `subshells.mdx` "Launch and manage subshells" - from use/subshells.
- `workspaces.mdx` "Workspaces and panes" - from use/workspaces-panes.
- `presets.mdx` "Presets" - from use/presets.
- `sharing.mdx` "Share a subshell" - from use/sharing.
- `notifications.mdx` "Notifications" - from use/notifications.
- `channels.mdx` "Channels" - from use/channels.
- `devices.mdx` "Devices" - from use/devices.

### agents - keep the per-agent shape
- `index.mdx` "Agents overview" - from agents/index.
- `install-a-cli.mdx` "Install an agent CLI" - from agents/installing-agent-clis.
- `plugin-registry.mdx` "Install a plugin" - from agents/plugin-registry.
- `claude-code.mdx`, `codex.mdx`, `opencode.mdx`, `hermes.mdx`, `pi.mdx`,
  `terminal.mdx` - rewrite in place (same scope each).

### nodes - eight to seven
- `index.mdx` "Nodes overview" - from nodes/index.
- `add-a-node.mdx` "Add a node" - SPLIT from nodes/add-node (CLI enroll only).
- `desktop-node.mdx` "Turn a desktop into a node" - from nodes/client-as-node.
- `manage.mdx` "Manage a node" - MERGE nodes/managing-a-node + maintenance.
- `directory-allowlist.mdx` "Restrict directories" - from nodes/directory-allowlist.
- `sharing.mdx` "Share a node" - from nodes/sharing.
- `updating.mdx` "Update a node" - from nodes/updating.

### server - run the server (the biggest; split the monsters)
- `index.mdx` "Server overview" - from server/index.
- `desktop-app.mdx` "Install with the desktop app" (NEW) - from get-started/
  install-server desktop section + the app-supervisor part of server/service.
- `headless.mdx` "Install by hand" - from server/headless-install +
  get-started/install-server "Doing it by hand".
- `docker.mdx` "Run in Docker" - from server/docker.
- `configuration.mdx` "Configuration" - from server/configuration (flag detail
  already lives in reference/environment-variables; keep the pointer).
- `networking.mdx` "Networking and addresses" - from server/networking; wire/
  derivation mechanics hoist to concepts/security-model, ports to reference/ports.
- `service.mdx` "Service and autostart" - from server/service (minus the
  app-as-supervisor prose that moved to desktop-app).
- `users.mdx` "Users and roles" - from server/users-roles.
- `sign-in-providers.mdx` "Sign-in providers" - from server/sign-in-providers.
- `registration.mdx` "Registration and enrollment" - from server/registration-enrollment.
- `backups.mdx` "Backups" - from server/backups.
- `updating.mdx` "Update the server" - from server/updating.
- `logs.mdx` "Logs and debugging" - from server/logs-debug.
- `audit-log.mdx` "Audit log" - from server/audit-log.
- `reset.mdx` "Reset" - from server/reset.
- `network-plugins/index.mdx` + `tailscale`, `netbird`, `headscale`,
  `cloudflare-tunnel` - rewrite in place.
- RETIRE server/api-keys - content merges into automation/api-keys.

### automation - three pages
- `mcp.mdx` "The MCP server" - from automation/mcp-server.
- `rest-api.mdx` "REST API" - from automation/rest-api.
- `api-keys.mdx` "API keys" - MERGE automation/system-api-keys + server/api-keys.
- RETIRE automation/mcp-tools - becomes reference/mcp-tools.

### concepts - the Explain section (NEW folder)
- `index.mdx` "What Subshell is" - from about/index.
- `how-it-works.mdx` "How it works" - from about/how-it-works.
- `architecture.mdx` "Architecture" - MOVE from develop/architecture.
- `security-model.mdx` "Security model" - from about/security-model (+ networking
  mechanics hoisted in).
- `platforms.mdx` "Supported platforms" - from about/supported-platforms.
- `alternatives.mdx` "Compared with the alternatives" - from about/vs-alternatives.

### reference - lookup (ten pages; CLIs stay one page each)
- `server-cli.mdx` "subshell-server CLI" - from reference/server-cli; add a
  command summary table, keep one H2 per verb.
- `node-cli.mdx` "subshell CLI" - from reference/node-cli; same treatment.
- `environment-variables.mdx`, `files-and-paths.mdx`, `ports.mdx`
  (from ports-and-firewalls), `versions.mdx` (from version-compatibility),
  `node-protocol.mdx`, `glossary.mdx` - rewrite in place.
- `mcp-tools.mdx` - MOVE from automation/mcp-tools.

### help - troubleshoot (split the symptom page)
- `index.mdx` "Troubleshooting" (NEW router; leads with `subshell-server status`).
- `sign-in.mdx` "Sign-in and address errors" - SPLIT from help/troubleshooting
  (403 invalid origin, passkeys, loopback baked URL, boot refuses).
- `nodes.mdx` "Node and launch errors" - SPLIT from help/troubleshooting
  (offline/unreachable, node never online, program not found, service-vs-terminal).
- `install-updates.mdx` "Install and update errors" - SPLIT from
  help/troubleshooting (one-liner refuses, no server binary, crashed after restart).
- `panes.mdx` "Pane and terminal issues" - SPLIT from help/troubleshooting (tmux,
  attach glitches) + the tmux pieces.
- `faq.mdx`, `support.mdx`, `release-notes.mdx` - rewrite in place.
- Quoted error strings in every help page stay byte-identical to what code prints.

### develop - contributors (architecture moved out)
- `contribute.mdx` "Contribute to Subshell" - from develop/contribute-to-subshell.
- `write-docs.mdx` "Write the docs" - from develop/contribute-to-these-docs
  (now points at apps/docs/STYLE.md).
- `plugin-api.mdx` "Plugin API" - from develop/plugin-api.
- `harness-plugin.mdx` "Write a harness plugin" - from develop/harness-plugin.
- `network-plugin.mdx` "Write a network plugin" - from develop/network-plugin.
- `publish-plugin.mdx` "Publish a plugin" - from develop/publish-a-plugin.

## Cross-cutting fidelity notes

- Every security warning and destructive-action notice survives at equal
  strength wherever its host page moved (setup-window race, node-enrollment
  delegation, Close-is-permanent, allowlist empty=unrestricted, password-reset
  caveats, air-gap behavior, E2EE limits, plugin-trust reach).
- Splitting a page never drops a fact; a reader on any new page can reach every
  old fact by one link.
- The content-tree test and ROOT_PAGES pin are updated in integration to match
  the new tree; old files are deleted only after their destinations carry them.

## Execution

Writers (one per section, disjoint files) build the new pages from the map, in
STYLE.md voice, opener rule applied, reading their named source pages for every
fact. Then claim-diff auditors (one per section) verify each new page against
its mapped sources + code. Then integration: retire old files, wire every
meta.json + ROOT_PAGES, dead-link sweep, full verification, changeset, new PR.
