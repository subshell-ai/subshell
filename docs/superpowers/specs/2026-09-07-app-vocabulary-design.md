# App vocabulary and taxonomy

**Status:** approved 2026-09-07. Supersedes the `apps/frontend` → `apps/server/web`
nesting of the same week, which fixed the directory tree without fixing the words.

## The problem

One word meant two things, and the tree had started to encode the confusion.

`client` named both *the node-agent side of the product* (`apps/client/agent`, the
`subshell` daemon) and *the thing a human points at a control plane*. So:

- `apps/client/desktop` shipped as **"Subshell Client"** while actually being the
  **node** GUI — it registers a machine as a node and manages its agent.
- The real clients — the SPA and the phone app — carried no "client" branding at
  all and were filed under `apps/server/` because the server serves one of them.
- The `client-vX.Y.Z` release tag published the **agent** binary.

Each of those reads correctly only if you already know which sense of "client" is
meant, which is precisely the property a taxonomy is supposed to remove.

## The vocabulary

Three words. Each names exactly one thing, everywhere — directories, product
names, component ids, tags, artifacts and prose.

| word | means | is not |
|---|---|---|
| **server** | the control plane: the API, its database, the SPA it serves | a machine that runs agents |
| **node** | a machine that runs agents — the `subshell` daemon and its GUI | a user-facing app |
| **client** | a human interface to a control plane — web, mobile, desktop | the node agent |

**The rule that matters:** no word may name two things. Every decision below is
downstream of that, and a future change that reintroduces an overloaded word is a
regression even if nothing breaks.

## Structure

```
apps/
  server/{api, web, desktop}     the control plane, its SPA, its GUI
  client/{desktop, mobile}       interfaces to a control plane
  node/agent                     the subshell daemon
```

`apps/server`, `apps/client` and `apps/node` are grouping directories with no
package of their own.

There is no `node/desktop`. Node management lives inside Subshell Client, which is
the substance of this design rather than a filing decision — see below.

## What ships

| product | what it is | artifacts |
|---|---|---|
| **Subshell Server** | desktop GUI: run and manage a control plane on this machine | `Subshell-Server-Desktop.app.tar.gz`, `subshell-server-desktop_<v>_amd64.deb` |
| **Subshell Client** | desktop GUI: connect to a control plane; optionally make this machine a node | `Subshell-Client-Desktop.app.tar.gz`, `subshell-client-desktop_<v>_amd64.deb` |
| `subshell-server` | the control-plane binary | `subshell-server-cli-<triple>` |
| `subshell` | the node agent binary | `subshell-node-cli-<triple>` |

Mobile is not released from this repo and keeps its own store pipeline.

### Component ids

The id is the git tag prefix, the dispatch option, the artifact prefix and the
`release:*` script name. It is deliberately separate from the directory (a nested
path is not a usable tag), and it follows the vocabulary:

| id | directory | tag |
|---|---|---|
| `server` | `server/api` | `server-vX.Y.Z` |
| `node` | `node/agent` | `node-vX.Y.Z` |
| `desktop-server` | `server/desktop` | `desktop-server-vX.Y.Z` |
| `desktop-client` | `client/desktop` | `desktop-client-vX.Y.Z` |

`client` as a component id is retired: it published the agent, which is the exact
overload this design exists to remove.

## Subshell Client: two windows

The client app absorbs the node GUI rather than sitting beside it. Whoever makes
their laptop a node is usually also watching subshells on it, and shipping that as
two installs asks the user to understand a split that serves only us.

| window | page | grant |
|---|---|---|
| `main` | the control plane's own SPA, at its origin | **nothing** — no capability names it |
| `node` | bundled (React, `ui/`) | every node command: enroll, install agent, service control, status |

This mirrors `apps/server/desktop`'s shape, with one deliberate difference
**decided during implementation**: that app pins its remote window to loopback
in `capabilities/main.json` and grants it three harmless commands, because it
manages the very server serving the page. A control plane can live on any host,
so there is no origin to enumerate here — and rather than reach for Tauri's
runtime ACLs, the window is granted nothing at all. Two supporting choices fall
out: it carries **no `SubshellDesktop/…` user-agent marker** (so the SPA never
takes its desktop-shell branch and never calls anything), and `on_navigation`
still pins it to the origin it opened with. It keeps
`disable_drag_drop_handler` and the 1024px floor, which are about rendering
rather than trust.

Node management — which installs a binary and drives a service — stays on the
bundled page the plane can never influence. That page also renders with the
plane unreachable, which is when it is most needed.

**The "node functionality" toggle is that window existing.** A client used purely
to watch subshells never opens it; there is no separate mode flag to keep
consistent. It is reached from the tray ("This machine…"), and it is what a
fresh install lands on — the plane window opens at startup only once an address
is settled (the stored `planeUrl`, else the enrolled node's own `serverUrl`).

## Decisions taken without further consultation

**The agent stays bundled** in Subshell Client rather than downloaded from the
plane. Downloading would guarantee a version match, but a plane's `node-artifacts`
directory is empty on a fresh binary-only install — so it would fail exactly during
first-time setup. Bundling keeps first run offline, and the existing version ladder
(adopt a newer installed agent, offer an upgrade, never downgrade) already handles
the mismatch case.

**Existing releases are deleted rather than left as history.** Every published
release names things in the retired vocabulary — `client-v*` carrying the agent,
`Subshell Client` being the node GUI. With no users, leaving them costs more
confusion than it preserves.

## Non-goals

- No `node/desktop`. If node management ever outgrows a window inside the client,
  that is a new design.
- No change to the CLIs' installed binary names (`subshell-server`, `subshell`),
  their commands, config paths, or service units. This is a naming and packaging
  change, not a behavioural one.
- No change to the bundle identifiers `dev.subshell.server` / `dev.subshell.client`
  — both are already correct under the new vocabulary.
- Mobile stays out of the release pipeline.
