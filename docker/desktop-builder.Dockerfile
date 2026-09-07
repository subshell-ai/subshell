# The Linux build environment for apps/server/desktop.
#
# A CONTAINER rather than the runner's own image, so the app's minimum
# supported Linux is a deliberate choice instead of an accident of whatever the
# self-hosted box was last re-imaged with. Ubuntu 24.04 sets that floor at
# glibc 2.39 — which excludes Ubuntu 22.04 and Debian 12, and is the one lever
# if that ever has to change.
#
# (24.04 was NOT required for WebKit: Jammy carries libwebkit2gtk-4.1-dev too.
# The floor is the whole reason for the tag.)
#
# Build and push:
#   docker build -f docker/desktop-builder.Dockerfile -t ghcr.io/subshell-ai/desktop-builder:ubuntu24.04 .
#   docker push ghcr.io/subshell-ai/desktop-builder:ubuntu24.04
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Tauri's own dependency list, plus four this pipeline specifically needs:
#   pkg-config  — arrives transitively, but every *-sys crate shells out to it
#   ca-certificates — rustup and cargo fetch over https
#   git         — the nested `release:server` ends in `git checkout` to restore
#                 the embedded-web stub, as root, over a runner-owned workspace
#   unzip       — bun's installer
#
# Deliberately NOT installed: patchelf. It is a linuxdeploy requirement, and
# AppImage is not a target here — leaving it in would invite a future reader to
# re-add the one bundler that reliably fails inside a container.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libxdo-dev \
      libssl-dev \
      libgtk-3-dev \
      build-essential \
      pkg-config \
      ca-certificates \
      curl \
      wget \
      file \
      git \
      unzip \
      dpkg-dev \
    && rm -rf /var/lib/apt/lists/*

# Pinned to the floor the repo asserts (`assertBunFloor("1.4.0")`).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

# The workspace is bind-mounted by the runner and owned by another uid; without
# this every `git` call in the build refuses with "dubious ownership".
RUN git config --global --add safe.directory '*'

RUN bun --version && rustc --version && pkg-config --modversion webkit2gtk-4.1
