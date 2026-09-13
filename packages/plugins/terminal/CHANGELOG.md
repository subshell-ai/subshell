# @subshell-ai/plugin-terminal

## 0.1.1

### Patch Changes

- [`8c7fc57`](https://github.com/subshell-ai/subshell/commit/8c7fc578c1c06185ef2c9538c521ca96b8711946) Thanks [@theogravity](https://github.com/theogravity)! - Ship the licence text, and say where the source is.
  
  Each of these declared `"license": "Apache-2.0"` in its manifest and shipped no
  copy of the terms, so an `npm install` delivered a package whose licence you
  could not read without finding the repository. Apache-2.0 section 4(a) asks for
  a copy of the licence to accompany the work, and `npm publish` is distribution.
  Each package now carries a LICENSE file, and `bun run lint:licenses` fails if a
  published package is missing one.
  
  Each package also declares `repository` (with the `directory` that points at it
  inside the monorepo), `homepage` and `bugs`, so the npm page links to the source,
  the site and the issue tracker instead of showing no link at all. And every
  published version now gets a GitHub Release carrying its own changelog entry —
  the version tags were being pushed with nothing against them.

## 0.1.0

### Minor Changes

- [`22739d3`](https://github.com/subshell-ai/subshell/commit/22739d3599647febb355ef07f42bec0c063020cc) Thanks [@theogravity](https://github.com/theogravity)! - A built-in `terminal` plugin: a plain shell in a subshell pane, with no agent and nothing to install.
