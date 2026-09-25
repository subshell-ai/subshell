# @subshell-ai/plugin-api

## 3.0.0

### Major Changes

- [#184](https://github.com/subshell-ai/subshell/pull/184) [`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58) Thanks [@theogravity](https://github.com/theogravity)! - Versioned to 3.0.0 in step with the 1.0 launch. These two packages passed
  1.0 before the product line marked it; rather than reach backward they
  take the next major, so every published component is now at 1.0.0 or
  deliberately past it.

## 2.1.2

### Patch Changes

- [`b68c249`](https://github.com/subshell-ai/subshell/commit/b68c2495e2beea0b470d089dd9ec705f46d669e8) Thanks [@theogravity](https://github.com/theogravity)! - The networking page reads like a form now
  
  Three copy fixes from an operator working through the live Headscale and
  NetBird cards. Each address in the Addresses list leads with its kind label
  above the URL — "NetBird FQDN", then the address — instead of a big bold URL
  with a small muted tag trailing it, which read as two disjoint things. The
  disabled Connect/Sign-in reason now says `Save the Control server URL first.`
  — naming the button that actually delivers the value, and keeping the label's
  own casing so the sentence names the same box the form does. And every
  credential box that can — all four built-ins now do — carries a Docs link
  beside its label, pointing at the vendor page where that key is minted:
  "Auth key" told you what to paste, and nothing on the card said where to get
  one. The link is new manifest data (`labels.credentialDocsUrl`, http(s)
  refused at parse), so third-party network plugins can carry one too.

- [`e69d619`](https://github.com/subshell-ai/subshell/commit/e69d619de7221bbeb1d55c0b4a8602b816303492) Thanks [@theogravity](https://github.com/theogravity)! - Network manifests may declare `publishImplicit: true`
  
  `subshell.network.publishImplicit` is a boolean a network plugin sets when its
  publish leaves NOTHING the daemon can later be asked about — NetBird's publish
  runs no command, so its status can only ever report `joined`. The flag tells
  the host that for that plugin its own publish record IS the published state,
  and the server upgrades `joined` to `published` only when the record exists
  AND the flag is set. A plugin without it is never upgraded: Tailscale's serve
  state is readable, so a serve reset from a terminal must keep showing `joined`
  however confidently the host's record disagrees. `parseManifest` refuses a
  non-boolean value.

- [`dbccc29`](https://github.com/subshell-ai/subshell/commit/dbccc29d411a519039d15197b08c9d063fa892f3) Thanks [@theogravity](https://github.com/theogravity)! - `supervisedProcess` may return a promise
  
  The contract widened at its first real use. The spec requires an ABSOLUTE
  `command`, resolved through `host.findBinary` — which is async — and the host
  re-asks `supervisedProcess` at every boot, on a fresh process where no earlier
  call cached anything. A purely synchronous member would have forced plugins to
  remember the path from a previous run (state the contract forbids) or arm
  nothing after a restart — silently breaking the "published survives a
  reboot" guarantee that member exists to serve. The host's boot pass now awaits
  the result; plugins that need no lookup may keep returning the spec directly.

## 2.1.1

### Patch Changes

- [`a5c9810`](https://github.com/subshell-ai/subshell/commit/a5c9810308afed92f1da95841a6c6fe4de65d5ea) Thanks [@theogravity](https://github.com/theogravity)! - On macOS, Tailscale's card offers the app as the route and the daemon as the alternative
  
  A Mac with nothing installed was told to `brew install --formula tailscale &&
  sudo tailscaled install-system-daemon` and then grant an operator. That is the
  open-source daemon, which Tailscale itself recommends "only for unattended
  installs managed by experienced macOS system administrators", and the card named
  nothing else. Installing the Tailscale app — which most people have or would
  install — did not even clear the row: its CLI lives inside the app bundle and is
  never on PATH unless the person enables the app's CLI integration.
  
  Measured on 2026-09-16, the app's CLI drives `status`, `up`, `serve` and
  `set --operator` with no root and no operator grant, because the app runs as the
  local user and so does this server. Three things follow:
  
  - Detection can name the bundle. A `knownPaths` entry that starts with `/` is
    now used as-is rather than joined onto HOME (which resolved
    `/Applications/Tailscale.app/…` to `$HOME/Applications/…` and silently matched
    nothing), so the app and both Homebrew directories are listed beside the
    HOME-relative one. The node agent shares that lookup and gains the same rule.
  - Every run sets `TAILSCALE_BE_CLI=1`. Run with a bare environment the app's
    binary tries to start the GUI and dies with `Tailscale.CLIError error 3.`; the
    variable is inert for the formula and its wrapper.
  - A privileged step can carry a `group`, which means ALTERNATIVE rather than
    next. The macOS row now prints one heading per route with an `or` between them
    and numbers inside a route only, where a flat 1-2-3 told a person to install
    the app AND the daemon. No other plugin is grouped, so no other row changed.
  
  A dead daemon on macOS now says both routes too, since the plugin cannot tell
  the app from the wrapper, and the two sentences cost less than a wrong guess.

## 2.1.0

### Minor Changes

- [`023d795`](https://github.com/subshell-ai/subshell/commit/023d795a57bfba90430b632844c8b05b1709f658) Thanks [@theogravity](https://github.com/theogravity)! - Connect this server to a private network, from a page instead of a config file
  
  Subshell has always been meant to be reached remotely across a perimeter you
  already own — a VPN, a mesh, a tunnel. Building that perimeter was yours to do,
  and the server only told you about it afterwards, as a `403 Invalid origin` on
  the sign-in page that named nothing you could change. The Add-node dialog's
  advice was "replace the host with this machine's VPN/LAN address".
  
  **Settings → Networking**, and an optional first-run step, now do it. Connect
  the server to a network, publish it there, and the address flows into the
  trusted origins and the enroll command by itself. **Tailscale** ships first:
  paste an auth key or sign in through a link the page shows you, then publish at
  `https://<host>.<tailnet>.ts.net`.
  
  It is a new kind of PLUGIN rather than four integrations wired into the stack,
  so the same store, install door and admin gate that govern agent plugins govern
  these, and anyone can publish one for a network we have not thought of. A
  network plugin describes and the host executes: it returns commands, parses
  their output and names a credential, but never spawns a process, writes a file,
  edits your config or reads a credential back.
  
  Three things it will tell you rather than let you discover:
  
  - **What needs root, and that this server will not do it.** Every mesh VPN
    installs a daemon as root, and the server has no terminal to answer a
    password prompt. Those commands are shown to copy, never run behind a button
    that could only fail. For Tailscale that is the whole install.
  - **What a browser will refuse at each address.** A mesh address over plain
    http is encrypted end to end and still will not do passkeys or `Secure`
    cookies. Publishing adds an address to the trusted origins, which is safe;
    promoting one to the server's base URL moves where passkeys work, which is
    opt-in and says so.
  - **Which networks work on this machine at all.** Support is declared per
    platform, so a row reads "not available on macOS" instead of offering a
    button that returns an error.
  
  Headscale, NetBird and Cloudflare Tunnel follow. Cloudflare will refuse to
  publish until a Cloudflare Access application covers the hostname, and the
  server will verify that assertion itself — it reaches the public internet,
  which the rest of these do not.

## 2.0.0

### Major Changes

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - The plugin contract speaks **preset**: `ProfileDefinition` is `PresetDefinition`, `BuildCommandInput.profile` is `.preset`, `validateProfile` is `validatePreset`, `profileSettings` is `presetSettings`, and the pure helper is `validateGenericPreset`. Nothing about the launch changed under the names — a preset is the same saved customisation, now optional, and an empty one is what a presetless launch feeds `buildCommand`.
  
  `PLUGIN_API_VERSION` is 2 and a plugin's manifest should declare `"apiVersion": 2`. The manifest gate accepts 1 and 2, and that is not a compatibility window: the loader checks members by name, so a v1 plugin (the `profile` spelling) is refused at LOAD as missing `validatePreset`, never as silently working. Rebuild against this version and rename the members. The six built-in plugins — Terminal included — ship rebuilt in the same release as the server that loads them.

### Minor Changes

- [`47e340d`](https://github.com/subshell-ai/subshell/commit/47e340dd04355551c5f4b84df03e0247b7e9e99a) Thanks [@theogravity](https://github.com/theogravity)! - Harnesses show their real marks instead of an emoji. `subshell.icon` now names
  an image file inside the plugin package rather than a glyph, each built-in
  ships its vendor's own logo, and the control plane serves it at
  `GET /api/plugins/<id>/icon`. A plugin that declares no icon renders a
  monogram. The mark shows wherever a harness is listed: first-run setup, the
  agent picker, Settings → Plugins (installed and catalog alike) and a node's
  harness list.

## 1.0.1

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

## 1.0.0

### Major Changes

- [`8cc452a`](https://github.com/subshell-ai/subshell/commit/8cc452a1085debece9d0b1a27080ff037330880a) Thanks [@theogravity](https://github.com/theogravity)! - The five built-in harnesses are plugin packages behind a published contract, and that contract's resume member is now pure.
  
  Nothing changes for a user: the same five harnesses are detected, launched and configured exactly as before, and parity is pinned by tests comparing each plugin's argv against the argv the class it replaced would have built. `@subshell-ai/plugin-api` is the contract a third party builds against; `packages/pane-runtime` holds no plugin classes, it loads them. A plugin cannot import anything of ours: everything reaches it through a `PluginHost` passed to the factory it default-exports, and a plugin's own build inlines `plugin-api`. Identity lives in the package's `package.json` under `subshell`, so listing and detection read data. One behaviour that was nearly lost is explicit in the contract: Hermes prints a version banner rather than a bare version, so a plugin can declare `parseVersion` to interpret its own probe output; the host owns the timeout.
  
  **Breaking:** `HarnessResume` no longer does I/O. `canResume(sessionId, cwd)` becomes `resumePath(sessionId, cwd, hostEnv)`, a PURE computation of where the resumable transcript WOULD be on the target machine, given a `HostEnv` (that machine's `homeDir` plus the values of the environment variables the plugin's manifest declares in the new `subshell.hostEnv` list; claude-code declares `CLAUDE_CONFIG_DIR`). The plugin answers "where", the HOST answers "is it there" — so the same plugin code computes the path whether the pane runs on the control-plane host or a remote node. A manifest naming the wrong variable is the documented landmine: it fails silently, as a resume that never offers itself, and the claude-code suite pins that as a permanent test.
  
  `@subshell-ai/plugin-api` is PUBLISHED, so this is a breaking change to a public contract, and it is taken deliberately: the package has been public for one day and nothing depends on it yet except these built-ins. Only claude-code implements `resume`, so only claude-code takes a major.
