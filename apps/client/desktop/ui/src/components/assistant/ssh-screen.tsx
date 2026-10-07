import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nodeOpenPlane, nodeSshConnect, nodeSshConnections, nodeSshDisconnect, nodeSshForget } from "@/lib/ipc";

const CONNECTIONS = ["desktop-ssh-connections"] as const;

/** Trusted, bundled consent surface. The server-loaded window has no SSH IPC. */
export function SshScreen({
  shell,
  rail,
  onBack,
  initialServer,
}: {
  shell: FrameShell;
  rail?: ReactElement;
  onBack: () => void;
  initialServer: string;
}) {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: CONNECTIONS, queryFn: nodeSshConnections, refetchInterval: 3000 });
  const [server, setServer] = useState(initialServer);
  const [token, setToken] = useState("");
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS });
      await queryClient.invalidateQueries({ queryKey: ["node-settings"] });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame
      {...shell}
      rail={rail}
      problem={problem || (connections.isError ? "Could not read saved connections." : shell.problem)}
      subtitle="Use this computer's SSH configuration and keys to work on remote hosts."
      barLeft={
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {(connections.data ?? []).map((connection) => (
          <div key={`${connection.server}:${connection.id}`} className="flex flex-col gap-2 rounded-lg border p-3">
            <p className="text-label font-strong">{connection.name}</p>
            <p className="text-detail text-muted-foreground break-all">
              {connection.server} · {connection.connected ? "Connected" : "Disconnected"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    connection.connected
                      ? nodeSshDisconnect(connection.server, connection.id)
                      : nodeSshConnect(connection.server, null, connection.id),
                  )
                }
              >
                {connection.connected ? "Disconnect" : "Reconnect"}
              </Button>
              {!connection.connected && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act(() => nodeSshForget(connection.server, connection.id))}
                >
                  Forget
                </Button>
              )}
              <Button disabled={busy} onClick={() => void act(() => nodeOpenPlane({ url: connection.server }))}>
                Open dashboard
              </Button>
            </div>
            <p className="text-detail text-muted-foreground">
              In the dashboard, choose New subshell → SSH host, then this computer. Disconnecting leaves remote panes
              running; reconnect to return to them.
            </p>
          </div>
        ))}
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-label font-strong">Connect this computer</h2>
          <p className="text-detail text-muted-foreground">
            Open your Subshell server's Settings → Connections, choose Add computer, and copy its pairing code here.
            This does not register this computer as a node.
          </p>
          <Label htmlFor="ssh-server">Server address</Label>
          <Input
            id="ssh-server"
            value={server}
            disabled={busy}
            placeholder="https://subshell.example.com"
            onChange={(event) => {
              setServer(event.target.value);
              setTrust(false);
            }}
          />
          <Label htmlFor="ssh-pairing">Pairing code</Label>
          <Input
            id="ssh-pairing"
            type="password"
            autoComplete="off"
            value={token}
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
          />
          <label className="flex items-start gap-2 text-detail">
            <input
              type="checkbox"
              checked={trust}
              disabled={busy}
              onChange={(event) => setTrust(event.target.checked)}
            />
            <span>
              I trust this server and the account that created this code to connect to hosts using my SSH configuration
              and keys while connected.
            </span>
          </label>
          <Button
            disabled={busy || !trust || !server.trim() || !token.trim()}
            onClick={() =>
              void act(async () => {
                await nodeSshConnect(server.trim(), token.trim(), null);
                setToken("");
                setTrust(false);
              })
            }
          >
            {busy ? "Connecting…" : "Connect this computer"}
          </Button>
          <p className="text-detail text-muted-foreground">
            Keep Subshell Client open while working remotely. Saved connections can reconnect without another code.
            Revoke access in the server's Connections settings.
          </p>
        </div>
      </div>
    </Frame>
  );
}
