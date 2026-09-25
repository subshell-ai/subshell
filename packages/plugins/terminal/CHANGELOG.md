# @subshell-ai/plugin-terminal

## 1.0.0

### Major Changes

- [#184](https://github.com/subshell-ai/subshell/pull/184) [`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58) Thanks [@theogravity](https://github.com/theogravity)! - Marked 1.0.0. Every harness and network plugin still below 1.0 joins the
  product line's first stable release.

## 0.2.0

### Minor Changes

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - The plugin contract speaks **preset**: `ProfileDefinition` is `PresetDefinition`, `BuildCommandInput.profile` is `.preset`, `validateProfile` is `validatePreset`, `profileSettings` is `presetSettings`, and the pure helper is `validateGenericPreset`. Nothing about the launch changed under the names — a preset is the same saved customisation, now optional, and an empty one is what a presetless launch feeds `buildCommand`.
  
  `PLUGIN_API_VERSION` is 2 and a plugin's manifest should declare `"apiVersion": 2`. The manifest gate accepts 1 and 2, and that is not a compatibility window: the loader checks members by name, so a v1 plugin (the `profile` spelling) is refused at LOAD as missing `validatePreset`, never as silently working. Rebuild against this version and rename the members. The six built-in plugins — Terminal included — ship rebuilt in the same release as the server that loads them.

- [`47e340d`](https://github.com/subshell-ai/subshell/commit/47e340dd04355551c5f4b84df03e0247b7e9e99a) Thanks [@theogravity](https://github.com/theogravity)! - Harnesses show their real marks instead of an emoji. `subshell.icon` now names
  an image file inside the plugin package rather than a glyph, each built-in
  ships its vendor's own logo, and the control plane serves it at
  `GET /api/plugins/<id>/icon`. A plugin that declares no icon renders a
  monogram. The mark shows wherever a harness is listed: first-run setup, the
  agent picker, Settings → Plugins (installed and catalog alike) and a node's
  harness list.

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
