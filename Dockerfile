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
 && apt-get install -y --no-install-recommends tmux git openssh-client ca-certificates curl unzip libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# The pi vendor installer (and any npm-routed agent-install/update rail run
# inside the container) hard-requires Node >= 22.19; trixie's nodejs is 20.x
# (spec 2026-09-28 § 3, operator ruling 2026-09-29). NodeSource covers both
# shipped architectures.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash subshell \
 && mkdir -p /data \
 && chown subshell:subshell /data \
 # A NAMED volume initializes from this dir's ownership AND mode, so 777
 # here lets any --user write it. Docker reaches no bind mount from the
 # image: there the host dir's owner decides (proxmox-server.sh chowns
 # /var/lib/subshell to 1000:1000, compose users own theirs).
 && chmod 777 /data

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER subshell
ENV HOME=/home/subshell
# System dirs FIRST so a host bind-mount at /usr/local/bin/claude (the compose
# rail's CLAUDE_BIN override) shadows the baked CLI. The harnesses live in the
# home dirs, which stay on PATH, so the gate below still passes.
ENV PATH="/usr/local/bin:/usr/bin:/bin:/home/subshell/.npm-global/bin:/home/subshell/.local/bin:/home/subshell/.opencode/bin:/home/subshell/.bun/bin"

RUN set -eux; \
    curl -fsSL https://claude.ai/install.sh | bash; \
    curl -fsSL https://chatgpt.com/codex/install.sh | sh; \
    curl -fsSL https://opencode.ai/install | bash; \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash; \
    curl -fsSL https://pi.dev/install.sh | sh; \
    command -v claude codex opencode hermes pi

# The server binary lands LAST: a release refresh must not bust the five
# installer layers above it. --chmod does in the COPY what the old RUN chmod
# did as a layer of its own.
ARG TARGETARCH
COPY --chmod=0755 docker/bin/subshell-server-${TARGETARCH} /usr/local/bin/subshell-server

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    DATABASE_PATH=/data/subshell.db \
    SUBSHELL_SERVER_CONFIG_DIR=/data \
    SUBSHELL_CONTAINER=1

EXPOSE 3080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
