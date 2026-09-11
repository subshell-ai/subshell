/**
 * Which installer the console offers, as a pure function of the platform.
 *
 * Separate from `main.js` for the same reason `config-form.js` is: this is the
 * part with a contract rather than a rendering, and it is the part worth
 * testing without a webview.
 *
 * **tmux is never bundled.** A static build would mean a musl toolchain in the
 * CI builder image (which strands ~2 GB of layers on every runner that pulled
 * it), a bundled terminfo directory, a second sidecar in the macOS notarize
 * path, and a CVE cadence for a C dependency nothing here owns. The platform's
 * own package manager is the smaller, honest answer.
 */

/** The docs page to send someone to when we cannot run an installer for them. */
const TMUX_DOCS = "https://formulae.brew.sh/formula/tmux";

/**
 * How to install tmux here.
 * @param {string} platform - "darwin", "linux", or anything else
 * @param {boolean} hasBrew - whether `brew` resolves on the login PATH
 * @returns {{kind: "run"|"manual", label: string, command: string[], docsUrl: string}}
 *   `run` means the console may offer a button; `manual` means it must show
 *   the command and let the user run it.
 */
export function tmuxInstallPlan(platform, hasBrew) {
  if (platform === "darwin") {
    if (hasBrew) {
      return { kind: "run", label: "Install tmux", command: ["brew", "install", "tmux"], docsUrl: TMUX_DOCS };
    }
    // No package manager we can drive. Homebrew itself is too large a thing
    // to install on someone's behalf from a setup screen, so this names the
    // alternative rather than pretending the button could work.
    return {
      kind: "manual",
      label: "Install tmux with MacPorts",
      command: ["sudo", "port", "install", "tmux"],
      docsUrl: TMUX_DOCS,
    };
  }
  if (platform === "linux") {
    // pkexec so the user gets their desktop's own password prompt. A bare
    // sudo from a GUI has no terminal to read a password from and simply
    // hangs until the timeout.
    return {
      kind: "run",
      label: "Install tmux",
      command: ["pkexec", "apt-get", "install", "-y", "tmux"],
      docsUrl: TMUX_DOCS,
    };
  }
  return { kind: "manual", label: "Install tmux", command: ["tmux"], docsUrl: TMUX_DOCS };
}

/**
 * The install commands for the agents this app may run on a user's behalf.
 *
 * BUILT-INS ONLY, and the ids and strings are duplicated here rather than read
 * from a manifest on purpose: this list is what the console is allowed to
 * EXECUTE, so it must be readable in one place and changeable only by editing
 * this file. A registry-driven version of this would let an installed plugin
 * choose what the desktop app runs.
 *
 * All five are user-space installers that need no elevation.
 */
const AGENT_INSTALLS = {
  "claude-code": "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  hermes: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  pi: "curl -fsSL https://pi.dev/install.sh | sh",
};

/**
 * How to install one built-in agent CLI, or null when this app will not.
 * @param {string} id - plugin id
 * @returns {{kind: "run", label: string, command: string[]}|null}
 */
export function agentInstallPlan(id) {
  const script = Object.hasOwn(AGENT_INSTALLS, id) ? AGENT_INSTALLS[id] : undefined;
  if (!script) return null;
  return { kind: "run", label: `Install ${id}`, command: ["sh", "-c", script] };
}
