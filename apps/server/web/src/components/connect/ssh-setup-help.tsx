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
            ? "Before accepting the connection, check that the SHA256 fingerprint matches the one shown in the host’s console, or ask its administrator to confirm it. Then leave the SSH shell and try connecting here again."
            : "This host’s SSH key has changed or was revoked. Ask its administrator to confirm the new fingerprint before updating this account’s known_hosts file. Keep host-key checking enabled, then try again."}
        </p>
      </div>
    );
  }
  if (code === "runtime_missing" || code === "session_protocol") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-detail">You can reach this host. Let’s get Subshell ready to run there:</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-detail">
          <li>
            Open a terminal on {origin}, then log in to the remote host:
            <CopyCommandRow text={login} label="SSH login command" />
          </li>
          <li>
            Check which operating system and processor the remote host uses:
            <CopyCommandRow text="uname -s; uname -m" label="platform check" />
            Choose Linux for Linux or macOS for Darwin. For the processor, choose x64 for x86_64, or arm64 for aarch64
            or arm64.
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
            for that operating system and processor. Copy the downloaded program to the remote host and name it{" "}
            <code>subshell</code>. Choose a release with SSH support.
          </li>
          <li>
            In the remote folder where you saved the download, run this command to install it. You may need an
            administrator’s help:
            <CopyCommandRow text="install -m 755 ./subshell /usr/local/bin/subshell" label="runtime install command" />
            You’ll also need tmux on the remote host (on Ubuntu: <code>sudo apt-get install tmux</code>).
          </li>
          <li>
            Back on {origin}, check that SSH can find both programs:
            <CopyCommandRow text={`${login} 'subshell --version; tmux -V'`} label="runtime verification command" />
            Once both version numbers appear, select Retry connection here. You can start with Terminal and install an
            agent later. There’s no need to enroll this host as a node or set up a service.
          </li>
        </ol>
      </div>
    );
  }
  return null;
}
