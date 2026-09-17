---
"@internal/server": patch
"@subshell-ai/plugin-netbird": patch
"@subshell-ai/plugin-headscale": patch
"@subshell-ai/plugin-cloudflare-tunnel": patch
"@internal/docs": patch
---

Fix the three open GitHub issues, all found by fact-checking the docs.

- Manual MCP registration steps (hermes, pi) now show the portable `subshell mcp` PATH command instead of the control plane's own resolved launch (#57). The steps are pasted onto every machine that hosts a pane, and an absolute server path names a program an enrolled node does not have; `subshell` is each node's own binary. The docs' swap-the-path caveat is gone, since the shown command is what to run.
- headscale's refused-serve advice now matches the shipped origins model: a private network's addresses are trusted while the machine is joined, so the refusal says the plain `http://<name>:<port>` address is already trusted instead of telling the operator to add it (#61).
- netbird's npm tarball now carries the icon it declares (`files` said `icon.svg`; the file and the manifest both say `icon.png`), so a registry-installed netbird shows its official mark instead of the monogram (#64). headscale and cloudflare-tunnel were carrying the same kind of dead `icon.svg` entry and are cleaned up too; a new pane-runtime test fails on any plugin whose declared icon is not in `files`, or whose `files` names an icon that does not exist.
