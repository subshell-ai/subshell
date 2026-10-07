import { SUBSHELL_REPO_SLUG } from "@internal/subshell-protocol";
import { CopyCommandRow } from "@/components/copy-command-row";

/** Shell-quote display commands too: an SSH alias is configuration data. */
export function sshLoginCommand(alias: string): string {
  return `ssh -- '${alias.replaceAll("'", "'\\''")}'`;
}

/** Recovery instructions name both accounts; commands are copied, never executed by the page. */
export function SshSetupHelp({
  code,
  alias,
  machine,
  account,
}: {
  code: string | null;
  alias: string;
  machine: string;
  account?: string;
}) {
  const login = sshLoginCommand(alias);
  const origin = `${machine}${account ? ` as ${account}` : ", using the account running Subshell"}`;
  if (code === "host_key_unknown" || code === "host_key_changed" || code === "host_key_revoked") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-detail">Open a terminal on {origin} and run:</p>
        <CopyCommandRow text={login} label="SSH login command" />
        <p className="text-detail text-muted-foreground">
          {code === "host_key_unknown"
            ? "Compare the displayed SHA256 fingerprint with the host administrator or the host’s console before accepting it. Then exit the SSH shell and retry here."
            : "The saved host identity changed or was revoked. Ask the host administrator to verify the replacement fingerprint and update this account’s known_hosts entry before retrying. Do not bypass host-key checking."}
        </p>
      </div>
    );
  }
  if (code === "runtime_missing" || code === "session_protocol") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-detail">SSH works. Set up the destination once:</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-detail">
          <li>
            Open a terminal on {origin}, then log in to the destination:
            <CopyCommandRow text={login} label="SSH login command" />
          </li>
          <li>
            On the destination, check its operating system and CPU:
            <CopyCommandRow text="uname -s; uname -m" label="platform check" />
            Linux or Darwin names the OS; x86_64 needs x64, and aarch64 or arm64 needs arm64.
          </li>
          <li>
            <a
              href={`https://github.com/${SUBSHELL_REPO_SLUG}/releases?q=cli-node`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Download the Subshell CLI
            </a>{" "}
            for that platform. Transfer the binary to the destination and rename it to <code>subshell</code>. Use a
            release that supports SSH runtimes.
          </li>
          <li>
            From the download directory on the destination, install it on the SSH account’s PATH. This command may
            require an administrator:
            <CopyCommandRow text="install -m 755 ./subshell /usr/local/bin/subshell" label="runtime install command" />
            Install tmux using the destination’s package manager (on Ubuntu: <code>sudo apt-get install tmux</code>).
          </li>
          <li>
            Back on {origin}, verify the noninteractive SSH environment:
            <CopyCommandRow text={`${login} 'subshell --version; tmux -V'`} label="runtime verification command" />
            Then retry here. No node enrollment or service setup is needed. Agents can be installed and signed in later;
            Terminal works without an agent.
          </li>
        </ol>
      </div>
    );
  }
  return null;
}
