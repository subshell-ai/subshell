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
`api/harness-utils.ts` for every node alike. And the plane RESOLVES the set:
`services/nodes/local-plugins.ts` points the pane-runtime registry overlay at
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

## Registering the MCP dialect per harness (moved from AGENTS.md "Architecture")

Cross-subshell comms (`subshell mcp`) is registered per harness by the plugin
itself: `services/mcp-launch.ts:registerSubshellMcp` asks the plugin for its
dialect (claude: `--mcp-config` file; opencode: merged config layer +
`OPENCODE_CONFIG`; codex: per-invocation `-c mcp_servers.subshell.*` overrides,
no per-subshell file), while harnesses without a per-subshell format (hermes, pi)
write nothing and expose one-time registration steps via `GET
/api/presets/harnesses/:id/schema` (rendered by the preset editor). The component map in
`apps/docs/content/docs/develop/architecture.mdx` places the MCP half.
