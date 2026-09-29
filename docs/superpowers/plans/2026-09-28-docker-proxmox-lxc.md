# Docker image + Proxmox LXC install rail - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a GHCR-published Subshell Server image built from the signed `cli-server` release, plus a Proxmox helper script that installs and updates it inside an unprivileged LXC, with the in-app update rail pointing at the image instead of a self-swap it cannot perform.

**Architecture:** The image packages (never compiles) the published release binary onto `debian:trixie-slim` with tmux and the five harness CLIs; a first-boot `init` mints the per-install `BETTER_AUTH_SECRET` on the data volume. CI verifies manifest signature and digests before any push. The server learns one new deployment fact (`containerized`, env-marked by the image) which flows through the existing refusal chain so every update surface names the image-pull remedy.

**Tech Stack:** Docker/buildx/GHCR, GitHub Actions, Bun/TypeScript (Elysia routes, bun:test), bash (helper script, cli-e2e scenario), fumadocs MDX.

**Spec:** `docs/superpowers/specs/2026-09-28-docker-proxmox-lxc-design.md` (all section refs below are to it).

## Global Constraints

- No U+2014 em dash anywhere in prose or shipped strings (`bun run lint:prose` enforces; every string in this plan is already clean).
- UI sentences: at most two, no backticks (they render literally in the plain-text reason lines); explanation lines are `detail` role.
- No dynamic imports; static top-level imports only (`.claude/rules/code-style.md`), and relative `../packages/...src/...js` imports inside root `scripts/` match `scripts/site-releases.ts`.
- All actions in new workflows pinned by full commit SHA with a human-readable `# vX.Y.Z` comment, the repo convention.
- Every `bun test` path must be verified to exist in the run output (bun silently skips typos).
- The compiled linux binaries need glibc >= 2.39; the base image is `debian:trixie-slim` (2.41). No other base is sanctioned.
- Task boundaries run `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` plus `bunx turbo build` (packages/ changes feed the Eden client); full set runs in Task 9.
- Commit messages: terse, conventional (`feat(...)`, `chore(...)`), author email theo@suteki.nu.

---

### Task 1: The `containerized` deployment fact

**Files:**
- Modify: `apps/server/api/src/services/server-deployment.ts` (near `SUPERVISOR_ENV` at :250-256; `DeploymentView` at :87-115; `buildDeployment` base block ~:384-402; final return ~:448)
- Modify: `apps/server/api/src/api/admin-server/schemas.ts` (the `restart: t.Object({...})` property at :80-83)
- Test: `apps/server/api/src/services/__tests__/server-deployment.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CONTAINER_ENV = "SUBSHELL_CONTAINER"`, `isContainerized(env?: NodeJS.ProcessEnv): boolean` exported from `@/services/server-deployment.js`; `DeploymentView.containerized: boolean` and a container-aware `restart.reason` string consumed by Tasks 2-3 and by `GET /api/admin/server` (schemas.ts).

- [ ] **Step 1: Write the failing test**

Append to `apps/server/api/src/services/__tests__/server-deployment.test.ts` (follow the existing `collectDeployment({...})` fake pattern from the "names the reason when not supervised" test at :90):

```ts
  it("names the image as the unit of update when the container marker is set (spec 2026-09-28 § 6)", () => {
    const view = collectDeployment({
      platform: "linux",
      pid: 1,
      env: { SUBSHELL_CONTAINER: "1" },
      applied: new Set(),
      queryService: () => service as never,
    });
    expect(view.containerized).toBe(true);
    expect(view.restart.available).toBe(false);
    expect(view.restart.reason).toContain("container");
    expect(view.restart.reason).toContain("proxmox.sh update");
  });

  it("reads the container fact from the marker only, not from anything else in the env", () => {
    expect(isContainerized({})).toBe(false);
    expect(isContainerized({ SUBSHELL_CONTAINER: "true" })).toBe(false);
    expect(isContainerized({ SUBSHELL_CONTAINER: "1" })).toBe(true);
  });
```

Add `isContainerized` to the test file's import from `@/services/server-deployment.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/api/src/services/__tests__/server-deployment.test.ts`
Expected: FAIL, `isContainerized` is not exported / `containerized` is not on the view.

- [ ] **Step 3: Implement in `server-deployment.ts`**

Beside the `SUPERVISOR_ENV` constants (~:250):

```ts
/**
 * The Subshell release image bakes this (spec 2026-09-28 § 3). It is the
 * server's only containerization signal: a marker the image sets, not a
 * guessed heuristic, because the fact it gates ("is the image the unit of
 * update?") is true exactly where our image said it was.
 */
export const CONTAINER_ENV = "SUBSHELL_CONTAINER";

/** Whether this process runs inside the Subshell release image. */
export function isContainerized(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONTAINER_ENV] === "1";
}
```

Beside `RESTART_UNSUPERVISED_REASON` (:191):

```ts
/** Why the image, not this process, is the unit of update (spec 2026-09-28 § 6). */
const RESTART_CONTAINERIZED_REASON =
  "This server runs inside a container, where the image is the unit of update. Pull a new image and recreate the container; from the Proxmox helper install, that is: bash proxmox.sh update on the host.";
```

In `DeploymentView` after the `restart` property (:99):

```ts
  /** True when this process runs inside the Subshell release image (`SUBSHELL_CONTAINER=1`). */
  containerized: boolean;
```

In `buildDeployment`, inside the `base` object literal (it holds everything independent of WHO supervises):

```ts
    containerized: isContainerized(env),
```

And in the final (non-`byApp`) return, replace the `restart:` line so the container sentence flows into every consumer (the restart route, `collectServerUpdateView`'s `canApply.reasons`, and the update route all read `restart.reason`):

```ts
    restart: {
      available: supervised,
      reason: supervised ? null : isContainerized(env) ? RESTART_CONTAINERIZED_REASON : RESTART_UNSUPERVISED_REASON,
    },
```

In `apps/server/api/src/api/admin-server/schemas.ts`, immediately after the `restart: t.Object({...})` property:

```ts
  containerized: t.Boolean({
    description: "True when this process runs inside the Subshell release container (SUBSHELL_CONTAINER=1)",
  }),
```

- [ ] **Step 4: Run tests, fix any key-set assertions the new field trips**

Run: `bun test apps/server/api/src/services/__tests__/server-deployment.test.ts apps/server/api/src/services/__tests__/server-deployment-cache.test.ts apps/server/api/src/api/admin-server/`
If a test asserts the serialized key set of the deployment view, add `"containerized"` to it.

- [ ] **Step 5: Typecheck and commit**

```bash
bunx turbo verify-types --filter=@internal/server
git add apps/server/api/src/services/server-deployment.ts apps/server/api/src/api/admin-server/schemas.ts apps/server/api/src/services/__tests__/server-deployment.test.ts
git commit -m "feat(deployment): containerized fact with the image-pull restart reason"
```

---

### Task 2: `UPDATE_CONTAINERIZED` refusal on the update route

**Files:**
- Modify: `packages/backend-errors/src/error-codes.ts` (enum beside `UPDATE_BINARY_UNKNOWN`; message table beside the other `UPDATE_*` entries at :346+)
- Modify: `apps/server/api/src/api/admin-server/update.route.ts:108-117` (refusal #2)
- Test: `apps/server/api/src/api/admin-server/__tests__/update.route.test.ts`, `restart.route.test.ts`, `apps/server/api/src/services/__tests__/server-update.test.ts`

**Interfaces:**
- Consumes: `DeploymentView.containerized` and `restart.reason` (Task 1).
- Produces: `BackendErrorCodes.UPDATE_CONTAINERIZED` (409) rendered by the POST refusals; `canApply.reasons` carries the same sentence for the updates page (flows automatically via `restart.reason`, asserted here). The spec's "Web: the admin update card's containerized state" therefore lands as ZERO SPA DIFF: `server-row.tsx` already renders every `canApply.reasons` entry as a `detail` line and disables the button on `!canApply.ok`; the copy lives server-side, which is why the test for it is a server test.

- [ ] **Step 1: Failing tests**

In `update.route.test.ts`, beside the existing `409 RESTART_UNAVAILABLE` test (:137):

```ts
  it("409 UPDATE_CONTAINERIZED when the image marker says the container is the unit of update", async () => {
    updateSeams.deployment = () => ({
      ...viewWith({ supervised: false, paneSafety: "keeps" }),
      containerized: true,
      restart: { available: false, reason: "This server runs inside a container, where the image is the unit of update." },
    });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(await code(res)).toBe("UPDATE_CONTAINERIZED");
    expect(started).toEqual([]);
  });
  // (The route's message flows from restart.reason - Task 1 set that string;
  // this test pins the CODE swap.)
```

In `restart.route.test.ts`, append inside the main describe (its `viewWith`/`post`/`fx` fixtures are reused):

```ts
  it("the unsupervised refusal NAMES the image-pull remedy when the container marker is set", async () => {
    restartSeams.deployment = () => ({
      ...viewWith({ supervised: false, paneSafety: "keeps" }),
      containerized: true,
      restart: {
        available: false,
        reason:
          "This server runs inside a container, where the image is the unit of update. Pull a new image and recreate the container; from the Proxmox helper install, that is: bash proxmox.sh update on the host.",
      },
    });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("RESTART_UNAVAILABLE");
    expect(body.message).toContain("proxmox.sh update");
    expect(performed).toBe(0);
  });
```

In `apps/server/api/src/services/__tests__/server-update.test.ts`, inside the `collectServerUpdateView` describe:

```ts
  it("lists the image-pull remedy among the blockers inside a container (spec 2026-09-28 § 6)", async () => {
    process.env.SUBSHELL_CONTAINER = "1";
    resetDeploymentCache();
    try {
      const view = await collectServerUpdateView(true);
      expect(view.canApply.ok).toBe(false);
      expect(view.canApply.reasons.some((r) => r.includes("container") && r.includes("proxmox.sh update"))).toBe(true);
    } finally {
      delete process.env.SUBSHELL_CONTAINER;
      resetDeploymentCache();
    }
  });
```

Add `resetDeploymentCache` to that file's imports from `@/services/server-deployment.js` (create the import if the file lacks one).

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/api/src/api/admin-server/__tests__/update.route.test.ts apps/server/api/src/api/admin-server/__tests__/restart.route.test.ts apps/server/api/src/services/__tests__/server-update.test.ts`
Expected: FAIL (unknown code / no such reason).

- [ ] **Step 3: Implement**

`packages/backend-errors/src/error-codes.ts`: add to the enum beside the other UPDATE_* members:

```ts
  UPDATE_CONTAINERIZED = "UPDATE_CONTAINERIZED",
```

and to the message table beside `UPDATE_SOURCE_DISABLED` (same 409 family):

```ts
  [BackendErrorCodes.UPDATE_CONTAINERIZED]: {
    message: "This server runs inside a container; the image is the unit of update",
    statusCode: 409,
  },
```

`apps/server/api/src/api/admin-server/update.route.ts`, refusal #2 (:108-117) becomes:

```ts
      const deployment = updateSeams.deployment();
      if (!deployment.service.supervised) {
        return status(
          409,
          apiErrorBody({
            // Inside the image the swap itself is the wrong act, not just the
            // missing restart; the container's name replaces the manager's
            // absence (spec 2026-09-28 § 6).
            code: deployment.containerized ? BackendErrorCodes.UPDATE_CONTAINERIZED : BackendErrorCodes.RESTART_UNAVAILABLE,
            message: deployment.restart.reason ?? "This server is not running under a service manager",
          }),
        );
      }
```

The restart route needs no code change: its message already flows from `view.restart.reason` (Task 1 set it).

- [ ] **Step 4: Run the focused tests to green**

Run: the Step 2 command. Then `bunx turbo verify-types --filter=<the backend-errors package name>` and `bun test packages/backend-errors`.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-errors apps/server/api/src/api/admin-server
git commit -m "feat(updates): UPDATE_CONTAINERIZED refusal naming the image-pull remedy"
```

---

### Task 3: `subshell-server update --check` speaks containerized

**Files:**
- Modify: `apps/server/api/src/commands/update.ts` (`UpdateCheck` at :178-186; the `locate` refusal in `runInstall` ~:190-196; the `pickRelease`-refusal JSON at :225-230; the success `check` at :267-275)
- Test: `apps/server/api/src/commands/__tests__/update.test.ts`

**Interfaces:**
- Consumes: `isContainerized` from `@/services/server-deployment.js`.
- Produces: `"containerized":true` in every `--check --json` object emitted by a containerized host (the docker e2e scenario, Task 5, asserts it); a prose line on `--check` without `--json`.

- [ ] **Step 1: Failing test**

Append to the `describe("update --check", ...)` block in `update.test.ts` (reuse its `run`, `logs` harness):

```ts
  it("marks check output containerized when the image marker is set", async () => {
    process.env.SUBSHELL_CONTAINER = "1";
    try {
      expect(await run({ from: incoming, check: true, json: true })).toBe(0);
      expect(JSON.parse(logs[0] ?? "{}")).toEqual({
        installed: SERVER_VERSION,
        latest: "9.9.9",
        updateAvailable: true,
        containerized: true,
      });
    } finally {
      delete process.env.SUBSHELL_CONTAINER;
    }
  });
```

- [ ] **Step 2: Verify it fails** (`bun test apps/server/api/src/commands/__tests__/update.test.ts`)

- [ ] **Step 3: Implement**

Add the static import `import { isContainerized } from "@/services/server-deployment.js";`. Extend the interface:

```ts
export interface UpdateCheck {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Why `latest` is null; absent when it is not. */
  reason?: string;
  /** Present-when-true: this binary lives in an image and updates by pull, not swap (spec 2026-09-28 § 6). */
  containerized?: true;
}
```

Define one helper beside it so all three emission sites share it:

```ts
/** The marker every --check JSON gains inside the image; absent elsewhere (no key churn outside). */
const CONTAINER_FLAG = (): { containerized?: true } => (isContainerized() ? { containerized: true as const } : {});
```

Site 1 - the `locate` refusal in `runInstall` currently answers `--check --json` with plain stderr text; give it the refusal-shaped JSON (mirroring the `pickRelease` refusal's existing treatment, exit 0 on the json form, unchanged otherwise):

```ts
  const located = locate(deps);
  if ("refusal" in located) {
    if (opts.check && opts.json) {
      log(
        JSON.stringify({
          installed: SERVER_VERSION,
          latest: null,
          updateAvailable: false,
          reason: located.refusal,
          ...CONTAINER_FLAG(),
        } satisfies UpdateCheck),
      );
      return 0;
    }
    error(`subshell-server: ${located.refusal}`);
    return 1;
  }
```

Site 2 - the existing `pickRelease` refusal JSON (`if (opts.check && opts.json)` at :225): add `...CONTAINER_FLAG(),` inside the stringified object.

Site 3 - the success path at :267:

```ts
  const check: UpdateCheck = {
    installed: SERVER_VERSION,
    latest: target.version,
    updateAvailable: semverLt(SERVER_VERSION, target.version),
    ...CONTAINER_FLAG(),
  };
```

And in the non-json `--check` rendering (right after the `log(\`Running ${SERVER_VERSION}...\`)` / "\`.x is available\`" branches), one honest sentence when flagged:

```ts
    if (isContainerized()) {
      log("This install runs in a container; updates happen by pulling a new image, not with this verb.");
    }
```

- [ ] **Step 4: Run to green** (`bun test apps/server/api/src/commands/__tests__/update.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/commands/update.ts apps/server/api/src/commands/__tests__/update.test.ts
git commit -m "feat(cli): update --check names the container as the unit of update"
```

---

### Task 4: The release image (Dockerfile, entrypoint, compose repoint)

**Files:**
- Replace: `Dockerfile`
- Create: `docker-entrypoint.sh`
- Modify: `docker-compose.yaml` (drop the `build:` block, repoint `image:`, relax `BETTER_AUTH_SECRET`)
- Modify: `.gitignore` (ignore `docker/bin/`)

**Interfaces:**
- Consumes: `subshell-server init`'s no-TTY branch (init.ts:223-273) and the release asset naming `subshell-server-cli-linux-<x64|arm64>`.
- Produces: an image with `/usr/local/bin/subshell-server`, baked harnesses on `PATH`, env `SUBSHELL_CONTAINER=1` (Tasks 1-6 read it), and `docker/bin/subshell-server-<amd64|arm64>` as its build-input convention (Task 6 stages it).

- [ ] **Step 1: Write `docker-entrypoint.sh`**

```bash
#!/bin/bash
# First boot provisions config.env - and with it a unique BETTER_AUTH_SECRET
# (32 random bytes, 0600) - through the SAME init rail the install one-liner
# hands off to. Stdin is forced off-a-TTY so every question takes its skip
# branch no matter how the container was started; the volume then keeps the
# file forever, so updates (which replace the container, never the volume)
# never rotate the secret. (spec 2026-09-28 § 3)
set -euo pipefail
if [ ! -f "${SUBSHELL_SERVER_CONFIG_DIR:-/data}/config.env" ]; then
  subshell-server init < /dev/null
fi
exec subshell-server "$@"
```

`chmod +x docker-entrypoint.sh`.

- [ ] **Step 2: Replace the root `Dockerfile`**

Full content:

```docker
# syntax=docker/dockerfile:1

# Subshell Server - the release image (spec 2026-09-28 § 3).
#
# PACKAGING, not compiling: docker/bin/subshell-server-<arch> is the published,
# signature-verified cli-server release binary, staged by docker-image.yml
# (scripts/docker-release-verify.ts refuses bad bytes). This image therefore
# carries the same artifact the install one-liner installs, and
# `subshell-server version` answers identically inside Docker and outside it.
#
# debian:trixie-slim: the Linux release floor is glibc 2.39 (the ubuntu-24.04
# build shards) and trixie carries 2.41; trixie is also what the Proxmox
# helper script's LXCs run, so host and container agree on the distro.
#
# The five harness CLIs are baked with the vendor one-liners the product's own
# install rails offer. Their versions float with build day; refreshing one
# inside a RUNNING container works through the admin UI's agent-install route
# without an image rebuild.

FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git openssh-client ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash subshell \
 && mkdir -p /data \
 && chown subshell:subshell /data \
 # 777 so a bind mount whose host dir arrives root-owned (a fresh
 # /var/lib/subshell, say) still becomes writable after docker chowns the
 # MOUNT, not the image dir. Named volumes inherit the image's ownership.
 && chmod 777 /data

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ARG TARGETARCH
COPY docker/bin/subshell-server-${TARGETARCH} /usr/local/bin/subshell-server
RUN chmod 0755 /usr/local/bin/subshell-server

USER subshell
ENV HOME=/home/subshell
ENV PATH="/home/subshell/.npm-global/bin:/home/subshell/.local/bin:/home/subshell/.opencode/bin:/home/subshell/.bun/bin:/usr/local/bin:/usr/bin:/bin"

RUN set -eux; \
    curl -fsSL https://claude.ai/install.sh | bash; \
    curl -fsSL https://chatgpt.com/codex/install.sh | sh; \
    curl -fsSL https://opencode.ai/install | bash; \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash; \
    curl -fsSL https://pi.dev/install.sh | sh; \
    command -v claude codex opencode hermes pi

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    DATABASE_PATH=/data/subshell.db \
    SUBSHELL_SERVER_CONFIG_DIR=/data \
    SUBSHELL_CONTAINER=1

EXPOSE 3080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
```

If a vendor installer needs a runtime the slim base lacks, add the package to the apt list - that repair belongs to THIS step (the `command -v` line is the gate), not a later fix.

- [ ] **Step 3: Repoint `docker-compose.yaml`**

Replace the `build:` + `image:` pair at the top of the service with:

```yaml
    # The published release image (spec 2026-09-28). To build from a staged
    # binary instead: mkdir -p docker/bin, drop subshell-server-<arch> there,
    # and `docker build -t subshell:local .`
    image: ghcr.io/subshell-ai/subshell:latest
```

Replace the `BETTER_AUTH_SECRET` environment entry (and its comment) with:

```yaml
      # No secret needed: first boot mints a unique one into
      # $SUBSHELL_SERVER_CONFIG_DIR/config.env on the data volume. To pin one
      # explicitly (moving an existing instance's sessions), uncomment the next
      # line - init persists a supplied value verbatim - and set it in .env:
      # BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
```

Update the stale comment above the `CLAUDE_BIN` mount block's first line to one sentence: the image now bakes harness CLIs; these mounts OVERRIDE them with the host's binaries/state when that is what you want. Leave every other mount and env line as is.

- [ ] **Step 4: Ignore the staging dir**

Append to `.gitignore`:

```
# Staged release binaries for the image build (docker-image.yml stages these)
docker/bin/
```

- [ ] **Step 5: Local build smoke (needs docker + network + `gh`)**

```bash
mkdir -p docker/bin
LATEST=$(gh release list -R subshell-ai/subshell --exclude-drafts --exclude-pre-releases --limit 100 \
  --json tagName --jq '.[].tagName' | grep '^cli-server-v' | sed 's/^cli-server-v//' | sort -V | tail -1)
gh release download "cli-server-v${LATEST}" -R subshell-ai/subshell \
  -p 'subshell-server-cli-linux-x64' -p 'subshell-server-cli-linux-x64.sha256' -D docker/bin/
sha256sum -c <(printf '%s  docker/bin/subshell-server-cli-linux-x64\n' "$(cat docker/bin/subshell-server-cli-linux-x64.sha256 | tr -d '[:space:]' | cut -c1-64)")
mv docker/bin/subshell-server-cli-linux-x64 docker/bin/subshell-server-amd64
docker build -t subshell:local .
docker run -d --name subshell-smoke -p 31998:3080 subshell:local
until curl -sf http://127.0.0.1:31998/api/setup/status >/dev/null; do sleep 1; done
docker exec subshell-smoke subshell-server version | grep -qF "subshell-server ${LATEST}"
docker exec subshell-smoke bash -lc 'command -v tmux claude codex opencode hermes pi'
docker exec subshell-smoke bash -c 'test -f /data/config.env && grep -q "^BETTER_AUTH_SECRET=.\{32,\}" /data/config.env'
docker rm -f subshell-smoke
```

Expected: build succeeds (the harness `command -v` gate passes inside the image build itself), every assertion prints nothing (success), final `docker rm` names the container.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-entrypoint.sh docker-compose.yaml .gitignore
git commit -m "feat(docker): release image packaging the signed cli-server binary with tmux and the five harnesses"
```

---

### Task 5: `scripts/cli-e2e/docker-image.sh` scenario

**Files:**
- Create: `scripts/cli-e2e/docker-image.sh` (executable)

**Interfaces:**
- Consumes: a built/pushed image ref; `subshell-server update --check --json`'s `containerized` field (Task 3).
- Produces: `bash scripts/cli-e2e/docker-image.sh <image-ref> [<version>]` - the same contract run standalone by an operator and called by docker-image.yml's smoke job (Task 6).

- [ ] **Step 1: Write the scenario**

```bash
#!/usr/bin/env bash
#
# The container end-to-end scenario: boots a BUILT Subshell image and asserts
# the container contract from the outside - version, PATH, per-install secret,
# the image-pull update story, and a recreate that keeps config.env
# byte-identical. (spec 2026-09-28 § 8)
#
#   bash scripts/cli-e2e/docker-image.sh ghcr.io/subshell-ai/subshell:1.2.3 [1.2.3]
#
# Takes an image ref (any locally-built tag works too) and optionally the
# version its `version` verb must print. Needs docker and network (the update
# --check hits the release source, and a fresh pull needs GHCR). Deliberately
# NOT wired into run.sh: the suite there builds from source; this one tests a
# finished image. Port 31998 (the 31992-31999 family).
set -euo pipefail
IMAGE="${1:?usage: docker-image.sh <image-ref> [version]}"
EXPECTED_VERSION="${2:-}"
NAME="subshell-e2e-$$"
VOL="subshell-e2e-$$"
PORT=31998
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker volume create "$VOL" >/dev/null

boot() {
  docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:3080" -v "$VOL:/data" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/api/setup/status" >/dev/null && return 0
    sleep 1
  done
  echo "FAIL: the server never answered /api/setup/status" >&2
  docker logs "$NAME" >&2
  return 1
}

echo "==> boot + readiness"
docker pull "$IMAGE" >/dev/null 2>&1 || true   # a local build has nothing to pull; fine
boot

echo "==> version"
VERSION_OUT=$(docker exec "$NAME" subshell-server version)
echo "    $VERSION_OUT"
if [ -n "$EXPECTED_VERSION" ]; then
  [ "$VERSION_OUT" = "subshell-server $EXPECTED_VERSION" ] || { echo "FAIL: expected subshell-server $EXPECTED_VERSION" >&2; exit 1; }
fi

echo "==> tmux + the five harnesses resolve in-container"
docker exec "$NAME" bash -lc 'command -v tmux claude codex opencode hermes pi' >/dev/null

echo "==> the update rail names the image as the unit of update"
CHECK_JSON=$(docker exec "$NAME" subshell-server update --check --json || true)
echo "$CHECK_JSON" | grep -q '"containerized":true' || { echo "FAIL: --check did not report containerized: $CHECK_JSON" >&2; exit 1; }

echo "==> secret minted once, stable across a recreate"
SECRET1=$(docker exec "$NAME" sha256sum /data/config.env)
docker rm -f "$NAME" >/dev/null
boot
SECRET2=$(docker exec "$NAME" sha256sum /data/config.env)
# The volume survived the recreate, so config.env must be byte-identical - the
# same secret, not a re-mint one: init's keep-existing branch, verified.
[ "$SECRET1" = "$SECRET2" ] || { echo "FAIL: config.env changed across a container recreate" >&2; exit 1; }
docker exec "$NAME" bash -c 'grep -q "^BETTER_AUTH_SECRET=.\{32,\}" /data/config.env'

echo "OK: docker-image scenario passed for $IMAGE"
```

- [ ] **Step 2: Run it against a real artifact**

```bash
chmod +x scripts/cli-e2e/docker-image.sh
bash scripts/cli-e2e/docker-image.sh subshell:local "$LATEST"   # the image and version from Task 4 Step 5, rebuilt if pruned
```
Expected: all five sections print, final `OK:` line, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/cli-e2e/docker-image.sh
git commit -m "test(cli-e2e): docker image scenario (version, PATH, containerized rail, secret stability)"
```

---

### Task 6: Asset verification + `docker-image.yml`

**Files:**
- Create: `scripts/docker-release-verify.ts`
- Create: `.github/workflows/docker-image.yml`

**Interfaces:**
- Consumes: release assets `release-manifest.json` (+`.sig`) and `subshell-server-cli-linux-{x64,arm64}`; `verifyReleaseManifest` and `RELEASE_PUBKEY` from the protocol package's src (relative import, the `site-releases.ts` pattern); the image convention `docker/bin/subshell-server-<arch>` (Task 4).
- Produces: exit 0 + "verified:" lines on disk (CI refuses to push on anything else); a pushed multi-arch `ghcr.io/subshell-ai/subshell:<version>` and `:latest`; a smoke job that runs the Task 5 scenario.

- [ ] **Step 1: Write the verify script**

```ts
#!/usr/bin/env bun
// Verify staged release assets before they are baked into the Docker image
// (spec 2026-09-28 § 4). The rule is the product's own: the minisign signature
// over the manifest's exact bytes FIRST, then digests from the SIGNED assets
// map - never a .sha256 sidecar. Bad sig / bad digest / no manifest: refuse BY
// NAME, exit 1; the workflow pushes only on exit 0.
//
//   bun run scripts/docker-release-verify.ts <dir> <version>
//
// <dir> must hold release-manifest.json + .sig; either or both linux server
// binaries may be present (each per-arch CI job stages its own), and every
// present one is digest-checked.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_MANIFEST_NAME, RELEASE_MANIFEST_SIG_NAME, RELEASE_PUBKEY } from "../packages/subshell-protocol/src/releases.js";
import { verifyReleaseManifest } from "../packages/subshell-protocol/src/release-signature.js";

const [dir, version] = process.argv.slice(2);
if (!dir || !version) {
  console.error("usage: docker-release-verify.ts <dir> <version>");
  process.exit(1);
}

const manifestPath = join(dir, RELEASE_MANIFEST_NAME);
const sigPath = join(dir, RELEASE_MANIFEST_SIG_NAME);
if (!existsSync(manifestPath) || !existsSync(sigPath)) {
  console.error(`refused: ${dir} holds no ${RELEASE_MANIFEST_NAME} (+ .sig); nothing is trusted without the signature`);
  process.exit(1);
}

const verdict = await verifyReleaseManifest(readFileSync(manifestPath), readFileSync(sigPath, "utf8"), RELEASE_PUBKEY, {
  component: "cli-server",
  version,
});
if (!verdict.ok) {
  console.error(`refused: ${verdict.reason}`);
  process.exit(1);
}

const names = ["subshell-server-cli-linux-x64", "subshell-server-cli-linux-arm64"].filter((n) => existsSync(join(dir, n)));
if (names.length === 0) {
  console.error("refused: the staged dir holds no linux server binary to bake");
  process.exit(1);
}
for (const name of names) {
  const expected = verdict.manifest.assets[name];
  const actual = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  if (expected === undefined || expected !== actual) {
    console.error(`refused: ${name} digest ${actual} is not the signed ${expected ?? "(absent from the manifest)"}`);
    process.exit(1);
  }
  console.log(`verified ${name} ${actual.slice(0, 12)}...`);
}
console.log(`verified: release-manifest.json for cli-server ${version} + ${names.length} linux binary file(s)`);
```

- [ ] **Step 2: Prove the script refuses**

Against the real latest release (dir from Task 4 Step 5 plus `gh release download ... -p 'release-manifest.json*' -D docker/bin/` and the arm64 binary), then:

```bash
cp docker/bin/subshell-server-cli-linux-x64 docker/bin/subshell-server-cli-linux-arm64
bun run scripts/docker-release-verify.ts docker/bin "$LATEST"          # EXPECT: verified lines, exit 0
printf '{"tampered":true}' > /tmp/bad-manifest/release-manifest.json    # (mkdir -p first; copy the real .sig)
# tamper check: flip one byte of the real manifest copy -> EXPECT "refused: signature verification failed..." exit 1
```

Expected exact: the clean run ends with the "verified: release-manifest.json for cli-server" line; the tampered run exits 1 naming the refusal. (The arm64 slot holding an x64 copy still passes: the check is digest-vs-manifest on the STAGED bytes, and per-arch jobs download their real asset; this copy is only to exercise both name branches.)

- [ ] **Step 3: Write the workflow**

`.github/workflows/docker-image.yml` (pin every action to a full commit SHA discovered at landing time via `gh api repos/<owner>/<repo>/git/ref/tags/<v>`; the checkout/setup-bun SHAs below are copied from `website.yml` and already pin-identical):

```yaml
name: docker-image

# Package the published cli-server release into the GHCR image (spec
# 2026-09-28 § 4). The release shards are the input: this workflow downloads,
# signature-verifies, bakes, and pushes. It never compiles the server.
# Dispatchable with a version to rebuild an older release into a new image.

on:
  release:
    types: [published]
    tags: ["cli-server-v*"]
  workflow_dispatch:
    inputs:
      version:
        description: "cli-server version to package (e.g. 2.3.1)"
        required: true
        type: string

permissions:
  contents: read
  packages: write

concurrency:
  group: docker-image
  cancel-in-progress: false

env:
  IMAGE: ghcr.io/subshell-ai/subshell

jobs:
  build:
    # One job per architecture, each on a NATIVE runner: the harness installers
    # run inside the image build and must execute real arm64/amd64 code.
    strategy:
      matrix:
        include:
          - arch: amd64
            asset: linux-x64
            runner: ubuntu-24.04
          - arch: arm64
            asset: linux-arm64
            runner: ubuntu-24.04-arm
    runs-on: ${{ matrix.runner }}
    outputs:
      version: ${{ steps.plan.outputs.version }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: 1.4.2
      - name: Resolve the version
        id: plan
        run: |
          if [ "$GITHUB_EVENT_NAME" = "release" ]; then
            TAG="${{ github.event.release.tag_name }}"
          else
            TAG="cli-server-v${{ inputs.version }}"
          fi
          VERSION="${TAG#cli-server-v}"
          printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "::error::not a semver: $VERSION"; exit 1; }
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
      - name: Download the release assets
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          mkdir -p docker/dl docker/bin
          gh release download "${{ steps.plan.outputs.tag }}" -R subshell-ai/subshell \
            -p 'release-manifest.json' -p 'release-manifest.json.sig' \
            -p "subshell-server-cli-${{ matrix.asset }}" -D docker/dl
      - name: Verify signature and digests (refused by name on anything else)
        run: bun run scripts/docker-release-verify.ts docker/dl "${{ steps.plan.outputs.version }}"
      - name: Stage the verified binary
        run: cp "docker/dl/subshell-server-cli-${{ matrix.asset }}" "docker/bin/subshell-server-${{ matrix.arch }}"
      - uses: docker/setup-buildx-action@<PIN-FULL-SHA> # <version discovered at landing>
      - uses: docker/login-action@<PIN-FULL-SHA> # <version discovered at landing>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@<PIN-FULL-SHA> # <version discovered at landing>
        with:
          context: .
          push: true
          platforms: linux/${{ matrix.arch }}
          tags: ${{ env.IMAGE }}:${{ steps.plan.outputs.version }}-${{ matrix.arch }}
          provenance: false
          cache-from: type=gha,scope=docker-image-${{ matrix.arch }}
          cache-to: type=gha,scope=docker-image-${{ matrix.arch }},mode=max

  manifest:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - uses: docker/login-action@<PIN-FULL-SHA> # same pin as above
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Compose and push the multi-arch tags
        run: |
          V="${{ needs.build.outputs.version }}"
          docker buildx imagetools create \
            -t "$IMAGE:$V" -t "$IMAGE:latest" \
            "$IMAGE:$V-amd64" "$IMAGE:$V-arm64"
        env:
          IMAGE: ${{ env.IMAGE }}
      - name: Ensure the package is public (idempotent; first push would otherwise land private)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api -X PATCH /orgs/subshell-ai/packages/container/subshell -f visibility=public \
            || echo "::warning::could not flip package visibility - set it once at https://github.com/orgs/subshell-ai/packages"

  smoke:
    needs: [build, manifest]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      # Logged in even though the package ends up public: the FIRST run pushes
      # before visibility is confirmed flipped, and a private package is
      # otherwise unreadable here.
      - uses: docker/login-action@<PIN-FULL-SHA> # same pin as above
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Drive the container scenario against the pushed image
        env:
          IMAGE: ${{ env.IMAGE }}
          V: ${{ needs.build.outputs.version }}
        run: bash scripts/cli-e2e/docker-image.sh "$IMAGE:$V" "$V"
```

The `<PIN-FULL-SHA>` markers are the plan's ONLY discovery work, and it is exact: run `gh api repos/docker/setup-buildx-action/git/ref/tags/v3 --jq .object.sha` (and likewise for `docker/login-action` v3 and `docker/build-push-action` v6, or the newest tags at landing time), paste the SHAs with their version comments. A landing-time `grep -l PIN-FULL-SHA .github/workflows/` must come up empty.

- [ ] **Step 4: Land it**

The workflow triggers on `release: published` - it cannot be dry-run on a PR. Verification available here: `bun run scripts/docker-release-verify.ts` (Step 2) covers the trust gate; the build itself is proven by Task 4's local `docker build`. Push the branch, open the PR, and record in the PR body that the first real run is the next `cli-server` release (or a dispatch with the current newest version, which is sanctioned and equivalent).

- [ ] **Step 5: Commit**

```bash
git add scripts/docker-release-verify.ts .github/workflows/docker-image.yml
git commit -m "feat(ci): docker-image workflow packages the verified release into GHCR per-arch"
```

---

### Task 7: `proxmox.sh` helper script (+ serving, + shellcheck)

**Files:**
- Create: `proxmox.sh` (repo root, the `install-server.sh` placement precedent)
- Modify: `apps/website/scripts/prepare-data.ts:32` (the script copy list)
- Modify: `.github/workflows/lint.yml` (one shellcheck step in the `lint` job)

**Interfaces:**
- Consumes: the GHCR image (`ghcr.io/subshell-ai/subshell:latest`, public by Task 6), Docker CE inside the CT, port 3080 in-container.
- Produces: `curl -fsSL https://subshell.sh/proxmox.sh | bash` and `bash proxmox.sh update` (the remedy string Tasks 1-2 print). Standard verbs install / update / remove / backup / restore.
- Note: the spec's § 6 illustrative sentence `bash subshell.sh update` resolves here to the shipped file name, `bash proxmox.sh update`; the server-side string (Task 1) is the single truth and every test asserts against it.

- [ ] **Step 1: Write `proxmox.sh`**

```bash
#!/usr/bin/env bash
#
# Subshell - Proxmox VE LXC helper (spec 2026-09-28 section 5), the
# community-scripts convention: run on the PROXMOX HOST as root. Creates an
# unprivileged Debian trixie container with Docker inside it, runs the official
# Subshell image from GHCR, and updates it later with: bash proxmox.sh update
#
# Data (database, config.env with its minted secret, plugins, backups) lives on
# the CT's /var/lib/subshell, so updates never touch it. Running panes do not
# survive an update: the container owns its tmux server.

set -u

APP="Subshell"
IMG="ghcr.io/subshell-ai/subshell:latest"
CT_ID=""
CT_HOSTNAME="${CT_HOSTNAME:-subshell}"
CT_CORES="${CT_CORES:-1}"
CT_RAM_MB="${CT_RAM_MB:-2048}"
CT_DISK_GB="${CT_DISK_GB:-8}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
APP_PORT="${APP_PORT:-3080}"
CT_DATA="/var/lib/subshell"
CT_RUN_ENV="/etc/default/subshell-docker"
CT_NAME="subshell"
TEMPLATE_CACHE="/var/lib/vz/template/cache"

msg_ok() { echo -e "\e[32m[OK]\e[0m $*"; }
msg_err() { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }
header() { echo -e "\e[32m ==>\e[0m \e[1m$1\e[0m"; }

# fn_prompt VAR QUESTION DEFAULT  (PVE_NO_PROMPT=1 takes every default, for
# unattended runs, exactly like the community scripts' var_check posture)
fn_prompt() {
  local var="$1" question="$2" def="$3" answer=""
  if [[ "${PVE_NO_PROMPT:-0}" == "1" ]]; then
    eval "$var=\"\$def\""
    return
  fi
  read -rp "${question} [${def}]: " answer || answer=""
  eval "$var=\"${answer:-$def}\""
}

preflight() {
  [[ $EUID -eq 0 ]] || msg_err "run this on the Proxmox host as root"
  command -v pct >/dev/null 2>&1 || msg_err "pct not found: this is not a Proxmox host"
}

need_ct_id() {
  [[ -n "$CT_ID" ]] || read -rp "Container ID: " CT_ID
  [[ -n "$CT_ID" ]] || msg_err "no container id given"
  pct status "$CT_ID" >/dev/null 2>&1 || msg_err "no CT $CT_ID on this host"
}

default_storage() {
  local s
  s=$(pvesm status -content images 2>/dev/null | awk 'NR>1 {print $1; exit}')
  echo "${s:-local}"
}

# Newest debian-13 standard template filename for this host's arch.
latest_template() {
  local arch file
  [[ "$(uname -m)" == "x86_64" ]] && arch="amd64" || arch="arm64"
  file=$(curl -fsSL "https://download.proxmox.com/images/system/" |
    grep -oE "debian-13-standard_[0-9.]+-[0-9]+_${arch}\.tar\.zst" | sort -V | tail -1)
  [[ -n "$file" ]] || msg_err "no Debian 13 CT template found on download.proxmox.com"
  echo "$file"
}

# Waits for the in-CT web UI; prints nothing.
wait_up() {
  local port="$1" _
  for _ in $(seq 1 60); do
    pct exec "$CT_ID" -- curl -sf "http://127.0.0.1:${port}/api/setup/status" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ---------- install ----------
install_ct() {
  preflight
  header "Create the ${APP} container"
  local last
  last=$(pct list 2>/dev/null | tail -n +2 | awk '{print $1}' | sort -n | tail -1)
  fn_prompt CT_ID "Container ID" "$(( ${last:-100} + 1 ))"
  fn_prompt CT_HOSTNAME "Hostname" "$CT_HOSTNAME"
  fn_prompt CT_CORES "Cores" "$CT_CORES"
  fn_prompt CT_RAM_MB "Memory MB" "$CT_RAM_MB"
  fn_prompt CT_DISK_GB "Disk GB" "$CT_DISK_GB"
  fn_prompt CT_BRIDGE "Bridge" "$CT_BRIDGE"
  fn_prompt APP_PORT "Port the web UI maps on the CT" "$APP_PORT"

  local tmpl st rootpass
  st=$(default_storage)
  tmpl=$(latest_template)
  if [[ ! -f "${TEMPLATE_CACHE}/${tmpl}" ]]; then
    header "Downloading ${tmpl} (this can take a minute)"
    ( cd "$TEMPLATE_CACHE" && wget -q --show-progress "https://download.proxmox.com/images/system/${tmpl}" ) \
      || msg_err "template fetch failed"
  fi
  rootpass=$(openssl rand -base64 12)

  local sshkey="" args
  [[ -f /root/.ssh/id_ed25519.pub ]] && sshkey=$(cat /root/.ssh/id_ed25519.pub)
  [[ -z "$sshkey" && -f /root/.ssh/id_rsa.pub ]] && sshkey=$(cat /root/.ssh/id_rsa.pub)
  args=("$CT_ID" "local:vztmpl/${tmpl}"
    --unprivileged 1 --features nesting=1
    --hostname "$CT_HOSTNAME" --ostype debian
    --memory "$CT_RAM_MB" --swap 512 --cores "$CT_CORES"
    --disk "size=${CT_DISK_GB}G" --storage "$st"
    --net0 "name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
    --password "$rootpass")
  [[ -n "$sshkey" ]] && args+=(--ssh-public-keys "$sshkey")
  pct create "${args[@]}" || msg_err "pct create failed"
  pct start "$CT_ID" || msg_err "pct start failed"
  msg_ok "CT $CT_ID created (CT root password: ${rootpass})"
}

install_docker_in_ct() {
  header "Install Docker inside the CT"
  local _
  for _ in $(seq 1 60); do pct exec "$CT_ID" -- true 2>/dev/null && break; sleep 1; done
  pct exec "$CT_ID" -- bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl >/dev/null
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    systemctl enable --now docker
  ' || msg_err "Docker install inside the CT failed"

  header "Run the ${APP} container"
  pct exec "$CT_ID" -- bash -s -- "$APP_PORT" "$IMG" "$CT_DATA" "$CT_NAME" "$CT_RUN_ENV" <<'REMOTE'
    set -eu
    port="$1"; img="$2"; data="$3"; name="$4"; runenv="$5"
    mkdir -p "$data"
    # The image runs as uid 1000; a fresh host dir must be its to write.
    chown 1000:1000 "$data"
    printf 'APP_PORT=%s\nIMAGE=%s\nDATA=%s\nNAME=%s\n' "$port" "$img" "$data" "$name" > "$runenv"
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --restart unless-stopped \
      -p "$port:3080" -v "$data:/data" "$img" >/dev/null
REMOTE
  [[ $? -eq 0 ]] || msg_err "the ${APP} container failed to start"
  wait_up "$APP_PORT" || msg_err "the container never answered inside the CT (check: pct exec $CT_ID -- docker logs subshell)"
  local ip
  ip=$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')
  msg_ok "${APP} is up: http://${ip}:${APP_PORT}"
  echo "Register the first account there - it becomes the admin."
}

# ---------- update ----------
update_app() {
  preflight
  need_ct_id
  header "Pull the new image and recreate the container (running panes end; data survives)"
  pct exec "$CT_ID" -- bash -s -- "$CT_RUN_ENV" <<'REMOTE'
    set -eu
    runenv="$1"
    set -a; . "$runenv"; set +a
    rollback() {
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker rename "$NAME-old" "$NAME" >/dev/null 2>&1 || true
      docker start "$NAME" >/dev/null 2>&1 || true
      echo "update failed: the previous container is restored" >&2
      exit 1
    }
    docker pull "$IMAGE" || rollback
    docker rename "$NAME" "$NAME-old" || rollback
    docker stop "$NAME-old" >/dev/null || rollback
    docker run -d --name "$NAME" --restart unless-stopped \
      -p "$APP_PORT:3080" -v "$DATA:/data" "$IMAGE" >/dev/null || rollback
    ok=""
    for _ in $(seq 1 60); do
      curl -sf "http://127.0.0.1:$APP_PORT/api/setup/status" >/dev/null && { ok=1; break; }
      sleep 2
    done
    [[ -n "$ok" ]] || rollback
    docker rm -f "$NAME-old" >/dev/null 2>&1 || true
    echo "updated: $(docker exec "$NAME" subshell-server version)"
REMOTE
  [[ $? -eq 0 ]] || msg_err "update failed inside CT $CT_ID"
  msg_ok "${APP} updated"
}

# ---------- remove / backup / restore ----------
remove_ct() {
  preflight
  need_ct_id
  if [[ "${PVE_NO_PROMPT:-0}" != "1" ]]; then
    echo "This DESTROYS CT $CT_ID and everything in it."
    read -rp "Type yes to confirm: " a
    [[ "$a" == "yes" ]] || msg_err "cancelled"
  fi
  pct shutdown "$CT_ID" 2>/dev/null || true
  sleep 3
  pct stop "$CT_ID" 2>/dev/null || true
  pct destroy "$CT_ID"
  msg_ok "CT $CT_ID destroyed"
}

backup_ct() {
  preflight
  need_ct_id
  vzdump "$CT_ID" --mode snapshot --compress zstd --storage "$(default_storage)"
}

restore_help() {
  preflight
  echo "Restore is Proxmox's own flow: Datacenter -> Backup -> select the vzdump -> Restore."
  echo "A ${APP} backup is a full-CT snapshot, so restoring brings back the container, its Docker, and ${CT_DATA} as one."
}

# ---------- menu ----------
case "${1:-}" in
  install) install_ct; install_docker_in_ct ;;
  update) update_app ;;
  remove) remove_ct ;;
  backup) backup_ct ;;
  restore) restore_help ;;
  "")
    header "Menu"
    echo " 1) install   2) update   3) backup   4) restore help   5) remove"
    read -rp "Select: " sel
    case "$sel" in
      1) install_ct; install_docker_in_ct ;;
      2) update_app ;;
      3) need_ct_id; backup_ct ;;
      4) restore_help ;;
      5) need_ct_id; remove_ct ;;
      *) msg_err "no such option" ;;
    esac
    ;;
  *) msg_err "usage: proxmox.sh [install|update|remove|backup|restore]" ;;
esac
```

Landing notes (real review points, keep them in mind while transcribing): the remote heredocs are QUOTED (`<<'REMOTE'`) so host variables never expand inside them - runtime values arrive only as `bash -s --` arguments; `pct create` takes `--ssh-public-keys` (plural) and there is no public-key option worth passing when empty, hence the array; and `wait_up` is the single health gate both verbs share.

- [ ] **Step 2: Serve it at `subshell.sh/proxmox.sh`**

In `apps/website/scripts/prepare-data.ts:32`:

```ts
for (const script of ["install-server.sh", "install-client.sh", "proxmox.sh"]) {
```

Run `bun test apps/website/lib/__tests__/install.test.ts apps/website/lib/__tests__/releases.test.ts` - if a test pins the script list (it asserts the copy set today), add `"proxmox.sh"` there too.

- [ ] **Step 3: shellcheck (the CI gate)**

In `.github/workflows/lint.yml`, inside the `lint` job after the existing steps:

```yaml
      - name: shellcheck (new shell surfaces: Proxmox helper, image entrypoint, docker scenario)
        run: |
          sudo apt-get update -q
          sudo apt-get install -y -q shellcheck
          shellcheck -S warning proxmox.sh docker-entrypoint.sh scripts/cli-e2e/docker-image.sh
```

Run it locally now: `shellcheck -S warning proxmox.sh docker-entrypoint.sh scripts/cli-e2e/docker-image.sh` (install via `apt`/`brew` if absent). Expected: clean, zero warnings after fixing the markers from Step 1's notes. Also: `bash -n proxmox.sh && bash -n docker-entrypoint.sh && bash -n scripts/cli-e2e/docker-image.sh`.

- [ ] **Step 4: Commit**

```bash
git add proxmox.sh apps/website/scripts/prepare-data.ts .github/workflows/lint.yml
git commit -m "feat(proxmox): host helper script (install/update/remove/backup/restore) served at subshell.sh/proxmox.sh"
```

---

### Task 8: Docs

**Files:**
- Rewrite: `apps/docs/content/docs/server/docker.mdx`
- Create: `apps/docs/content/docs/server/proxmox.mdx`
- Modify: `apps/docs/content/docs/server/meta.json` (page list)
- Modify: `apps/docs/content/docs/server/updating.mdx` (one container section)
- Modify: `README.md` (the pointer line near L68)

**Interfaces:**
- Consumes: everything shipped by Tasks 1-7.
- Produces: the pages the update-card remedy sentence implies; no code changes.

- [ ] **Step 1: `server/docker.mdx`**

Rewrite around the shipped shape, keeping the existing mount table for the compose rail. The replacement must cover, each in a short section: what the image is (the release binary packaged on debian:trixie-slim with tmux + the five harness CLIs, `subshell-server version` answers the same as outside); first run (one volume at `/data`; first boot runs `init` and mints a unique `BETTER_AUTH_SECRET` into `/data/config.env` at 0600, so `docker run -d -v subshell-data:/data ghcr.io/subshell-ai/subshell:latest` needs no env except optionally `APP_BASE_URL`; prod boots fail loudly on the placeholder secret); updating (pull + recreate; sessions survive because the volume does; running panes do not survive because the container owns its tmux server; in-app update points here); the compose dev rail (now pulls the GHCR image, harness CLIs baked and host mounts overriding them); the pointer to the Proxmox page. Voice rules: neutral, one-sentence openers, no em dashes, no backticks in UI strings (docs prose may use them).

- [ ] **Step 2: `server/proxmox.mdx`**

New page: what it is (one command on the Proxmox host creates an unprivileged LXC with Docker inside and runs the Subshell image; the community-scripts convention with install/update/remove/backup/restore verbs); the one-liner `curl -fsSL https://subshell.sh/proxmox.sh | bash` (script source: `proxmox.sh` at the repo root); requirements (a Proxmox host, root, ~2 GB RAM / 8 GB disk defaults, all prompted and overridable); updating (`bash proxmox.sh update <CTID>` pulls the new image and recreates, rolling the old container back if the new one fails its health gate; data survives, panes do not); what lives where (host-side CT `/var/lib/subshell`: database, config.env with the minted secret, plugins, backups; the image itself is disposable); first run (open the printed URL, the first account becomes admin); security note in one sentence: Docker-in-LXC needs `nesting=1`, the CT stays unprivileged, and the instance follows the same trusted-network posture as any other deployment.

- [ ] **Step 3: Wire and cross-point**

`apps/docs/content/docs/server/meta.json`: insert `"proxmox"` after `"docker"` in the pages array.
`apps/docs/content/docs/server/updating.mdx`: add a short "Inside a container" section (three sentences): the image is the unit of update; `subshell-server update` refuses a containerized install with this spelled out; the Proxmox one-liner's `update` verb.
`README.md`: beside the existing docs pointer for Docker (~L68), extend to name the Proxmox page: `docker and proxmox lxc setup live in the docs (docs.subshell.sh)`.

- [ ] **Step 4: Verify and commit**

Run `bun run lint:prose` (the new MDX must be clean) and, if the docs app has a lint/build, `bunx turbo build --filter=<docs package>` to keep the nav check honest.

```bash
git add apps/docs README.md
git commit -m "docs: docker rewrite, proxmox lxc guide, updating pointer"
```

---

### Task 9: Boundary verification, PR, and the operator gate

**Files:** none (verification + handoff).

- [ ] **Step 1: Full suite**

```bash
bun run verify-types
bun run lint:check
bun run lint:prose
bun run test
bunx turbo build
```

All green (and if `bun test` shows an admin-server key-set failure, fix it and re-run).

- [ ] **Step 2: CLI e2e (update.ts changed)**

`bash scripts/cli-e2e/server-update.sh` per `verification.md` (it refuses on hosts with an installed per-user server; on this machine run it only if it refuses clean). Then the image scenario end-to-end once more: `bash scripts/cli-e2e/docker-image.sh subshell:local "$LATEST"`.

- [ ] **Step 3: PR and first-run gate**

Push `worktree-docker-image` (or a renamed branch `feat/docker-proxmox-rail`), open the PR, run `gh run watch` to green (memory: `gh pr merge --auto` merges immediately in this repo, do not use it). The PR body records the two things CI cannot test here: (1) the first `docker-image.yml` run happens on the next `cli-server` release, or dispatch it with the current newest version, (2) the Proxmox acceptance pass is manual: run `proxmox.sh install` on Theo's host, complete first-run registration, open a pane, `proxmox.sh update`, confirm the pane died and data survived. Do not merge before those are scheduled/named in review.

- [ ] **Step 4: Record the manual acceptance as done/blocked in the PR thread before merging.**
