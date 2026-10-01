# @subshell-ai/plugin-api

The Apache-2.0 contract and test helpers for [Subshell](https://subshell.sh)
harness and network plugins.

## Install

```sh
bun add --dev @subshell-ai/plugin-api
```

Import contract types and helpers from `@subshell-ai/plugin-api`; import
`createTestHost` and `createScriptedHost` from `@subshell-ai/plugin-api/testing`.
Package version `3.0.0` implements manifest API version `2`. These versions
have separate meanings; use the manifest version required by the contract.

## Documentation

The public developer documentation is the maintained source for examples,
manifest fields, interfaces, capabilities, and installation:

- [Build a harness plugin](https://docs.subshell.sh/developers/harness-plugin)
- [Build a network plugin](https://docs.subshell.sh/developers/network-plugin)
- [Plugin API reference](https://docs.subshell.sh/developers/plugin-api)
- [Publish a plugin](https://docs.subshell.sh/developers/publish-plugin)

## Runtime and trust

Default-export a factory and bundle third-party runtime dependencies, including
helpers from this package. Plugins load into a compiled server without an
adjacent `node_modules`; unresolved bare imports cannot rely on workspace
resolution. The host supplies services through `PluginHost`.

Plugins run in the server process with its OS privileges and no sandbox.
Host service restrictions are the supported contract, not a security boundary
against malicious plugin code. Installing a plugin is an instance-wide trust
decision. See the [security model](https://docs.subshell.sh/concepts/security).

## Working on this package

Keep implementation rationale next to the affected exported types, manifest
validators, and tests in `src/`. Update the public API reference when changing
the contract rather than adding a second tutorial here. Network supervision
and request-guard implementation boundaries are recorded in
[the engineering security model](../../docs/security.md).
