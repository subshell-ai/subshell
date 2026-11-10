# Plugins on the control plane: the full wiring account. Moved verbatim from AGENTS.md ("Architecture"); AGENTS.md keeps the summary and routes here.

Plugins live on the control plane now (spec 2026-09-10): the per-node
`set-node-plugin` route, `plugin-sync.ts` and the signed `plugin_install` /
`plugin_uninstall` commands are GONE, and with them the `nodes.plugins_json`
mirror they left behind (migration 0026, which also creates the instance-level
`plugin_state` table). The instance door is `api/plugins.route.ts`
(`/api/plugins`: list for any authenticated actor; install / enable / impact /
uninstall are cookie-admin, since installing runs third-party code in the
process that holds the node signing keypair). A registry `spec` still installs
VERBATIM (malformed spec is a 400 before any fetch, a failed install a 409
carrying the pane-runtime message), and the URL fetched from is
`SUBSHELL_PLUGIN_REGISTRY_URL` (constants.ts, same SETDEFAULT ladder as every
other server setting; `subshell-server status` prints it as
`plugin registry = <url>`; the route's `setPluginsRegistryUrlForTests` seam is
test-only by construction). `<dataDir>/plugins/` is the one installed set:
"usable" is (instance installed ∧ `plugin_state.enabled`; absent row =
enabled) × (that node's detection found the binary), computed once in
`modules/plugins/availability.ts` for every node alike. And the plane RESOLVES the set:
`modules/plugins/store.ts` points the pane-runtime registry overlay at
this store at boot and after every install and uninstall
(`refreshInstalledPlugins`), so `getHarness` answers for a registry-installed
plugin the moment the install returns (detect specs, preset validation, argv:
the whole launch path). Built-in ids always resolve to the compiled copy:
the seeded directories refresh silently, and a registry package claiming a
built-in id is warned about once and never loaded. That is also why
`plugins.route.ts` and `setup.route.ts` read `builtInHarnesses()` for their
offline-installable catalog region: once the overlay exists, the merged
`allHarnesses()` answers "what resolves", never "what can this build install".
The node never refreshes an overlay: after Task 7 it holds no plugin concept
at all, so its built-in-only view is structural, not configured. The
anonymous setup route has NO spec field; built-in ids only, forever (spec
2026-09-09 §13).

## Updating a harness CLI (issue #250)

The manifest's `subshell.update.command` updates the CLI a plugin drives, and
falls back to `subshell.install.command` when the vendor's installer is also
its updater (true of every built-in today). The adapter resolves that once
(`HarnessPlugin.updateHint`), so no surface re-derives it.

`POST /api/nodes/:id/harnesses/:pluginId/update` runs the line on the machine
that holds the harness: in the server's process for `local`, and through the
signed `harness_update` command (protocol 28) for an enrolled node. The gate
is `nodeCanConfigure` (the Re-check rule), and the run uses the installers'
bounds (`runBounded`: allowlisted environment, login-shell PATH, closed stdin,
ten-minute deadline, output cap). A non-zero exit is a reported RESULT, not an
HTTP error. After a remote run the node's cached detection is refreshed so its
version row catches up.

One harness run per node at a time (`claimHarnessRun`), because two CLIs
can share a package manager; a racing press answers 409 before the stream
opens. On an enrolled node the command rides its own serial chain, so the run
never holds pane effects behind it.

Each subshell records the version it launched on (`subshells.harness_version`,
migration 0073): a launch that asks with `probeVersion` (agent harnesses only)
makes the node answer RAW `<binary> --version` text on the ack, and the plane
parses it with the plugin. This is informational; nothing restarts a running
pane on a version change, by operator ruling.

## Installing a harness CLI on an enrolled node (issue #250)

`POST /api/nodes/:id/harnesses/:pluginId/install` installs the CLI a plugin
drives on the machine that will run it, through the signed `harness_install`
command (protocol 29). The control-plane host does not use it: its install is
the setup screen's in-process installer
(`POST /api/setup/agents/:pluginId/install`, admin cookie), and this route
answers 400 for `local` rather than opening a second gate onto that line.

Only a BUILT-IN plugin can be installed here. The installer line travels from
the manifest compiled into this binary, so what may run is changed by editing
this repo, never by anything a request sends; a registry plugin is refused even
when the instance offers it. The route is a browser-session act at the manage
band (`gate.canManage`: the owner or a `manage` grantee), and the refusals are
settled before the NDJSON body opens: unknown plugin 404, non-built-in or no
installer line 400, offline node 409, a harness run already on the node 409.

The run is bounded like the update's (the node's `runBounded`: allowlisted
environment, login-shell PATH, closed stdin, ten-minute deadline, output cap),
and the answer streams an NDJSON heartbeat every five seconds, then one
terminal `done` or `error`; node error text is capped at 4,096 characters.
Installs and updates share one harness-run slot per node, so a racing press
answers 409 before the stream opens. After a successful run the node's cached
detection is refreshed, best-effort, so its version row catches up. Audited as
`node.harness.install`, with `node.harness.install.unknown` only when a timeout
or a dropped socket leaves it unknowable whether the installer ran; neither row
carries output.

## Registering the MCP dialect per harness (moved from AGENTS.md "Architecture")

Cross-subshell comms (`subshell mcp`) is registered per harness by the plugin
itself: `modules/subshells/mcp-launch.ts:registerSubshellMcp` asks the plugin for its
dialect (claude: `--mcp-config` file; opencode: merged config layer +
`OPENCODE_CONFIG`; codex: per-invocation `-c mcp_servers.subshell.*` overrides,
no per-subshell file), while harnesses without a per-subshell format (hermes, pi)
write nothing and expose one-time registration steps via `GET
/api/presets/harnesses/:id/schema` (rendered by the preset editor). The component map in
`apps/docs/content/docs/concepts/architecture.mdx` places the MCP half.
