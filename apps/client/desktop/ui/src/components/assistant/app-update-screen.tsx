/**
 * Update Subshell Client — the APP, not the node agent it wraps.
 *
 * The screen beside the Connected screen's "Update the agent to X": that one
 * replaces `~/.local/bin/subshell` through that binary's own `update --from`,
 * this one replaces the `.app` (or the `.deb`) and relaunches. Both can be out
 * of date at once and they cost different things, so they are never one button.
 *
 * Reached from the tray's **Check for Updates…** and from the Connected
 * screen's disclosure (spec 2026-09-15 § 7.2).
 *
 * **It is the only screen here whose facts come from the network.** Everything
 * else this window shows is a probe of this machine on a two-second cycle; the
 * release list is a third party, and asking it on a cycle would be the
 * background update check the design explicitly does not have (spec § 14). So
 * the query is `staleTime: Infinity` with no refetch, and Check Again is the
 * only thing that asks twice.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { IS_MACOS } from "@/lib/copy";
import { type AppUpdateCheck, nodeCheckAppUpdate, nodeInstallAppUpdate } from "@/lib/ipc";

export const APP_UPDATE_KEY = ["node-app-update"] as const;

/** Megabytes, one decimal — the unit a download is read in. */
const mb = (n: number): string => (n / 1_000_000).toFixed(1);

export function AppUpdateScreen(props: { shell: FrameShell; onClose: () => void }) {
  const { data, isFetching, refetch, error } = useQuery<AppUpdateCheck>({
    queryKey: APP_UPDATE_KEY,
    queryFn: nodeCheckAppUpdate,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    // One try. A release source that will not answer arrives as `reason` on a
    // resolved check; a rejection here is the plugin refusing, which retrying
    // cannot fix.
    retry: false,
    refetchOnWindowFocus: false,
  });

  /** The download's own last line, from Rust's progress events. */
  const [progress, setProgress] = useState("");
  useEffect(() => {
    const unlisten = listen<{ received: number; total: number | null }>("node-app-update-progress", (event) => {
      const { received, total } = event.payload;
      setProgress(
        total === null ? `Downloading… ${mb(received)} MB` : `Downloading… ${mb(received)} of ${mb(total)} MB`,
      );
    });
    return () => {
      // Both halves swallow: a subscription that never came up has nothing to
      // tear down, and a teardown racing the window going away must not become
      // an unhandled rejection.
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  const install = useMutation({
    mutationFn: nodeInstallAppUpdate,
    onMutate: () => setProgress("Starting the download…"),
    // No `onSuccess`: this call does not resolve on success, because the app
    // restarts out from under this page.
    onError: () => setProgress(""),
  });

  const busy = isFetching || install.isPending;
  const problem = error instanceof Error ? error.message : install.error instanceof Error ? install.error.message : "";

  return (
    <Frame
      {...props.shell}
      problem={problem || props.shell.problem}
      icon={<Download />}
      barLeft={
        <Button variant="ghost" disabled={install.isPending} onClick={props.onClose}>
          Back
        </Button>
      }
      barRight={
        install.isPending ? undefined : (
          <Button className="min-w-[120px]" variant="outline" disabled={busy} onClick={() => void refetch()}>
            Check Again
          </Button>
        )
      }
    >
      {isFetching && <p className="text-center text-muted-foreground text-sm">Reading the project's release list.</p>}

      {!isFetching && data?.reason && (
        // A reason is NOT an error banner. An air-gapped install and a source
        // that would not answer are ordinary states of a machine, and a red
        // block over either teaches people to ignore red blocks.
        <div className="space-y-2 text-center text-sm">
          <p>This app could not check for updates.</p>
          <p className="text-muted-foreground text-detail">{data.reason}</p>
        </div>
      )}

      {!isFetching && data && !data.reason && data.latest === null && (
        <p className="text-center text-sm">Subshell Client {data.current} is the newest release.</p>
      )}

      {!isFetching && data?.latest && (
        <div className="space-y-4 text-center text-sm">
          <p>
            Subshell Client <span className="font-strong">{data.latest}</span> is available. This machine runs{" "}
            {data.current}.
          </p>
          {progress !== "" && <p className="text-muted-foreground text-detail">{progress}</p>}
          <p className="text-muted-foreground text-detail">
            The update is downloaded, its signature is checked against the key built into this app, and then Subshell
            Client restarts. The node agent on this machine is not touched and keeps running.
          </p>
          {/*
           * Linux installs through dpkg, which raises a system password sheet.
           * A sheet nobody was told about reads as malware — which is why this
           * one sentence branches on the platform: it is a genuine difference
           * in what the person has to DO, not in voice.
           */}
          {!IS_MACOS && (
            <p className="text-muted-foreground text-detail">
              Linux installs the package with dpkg, so your system will ask for your password.
            </p>
          )}
          <div>
            <Button disabled={busy} onClick={() => install.mutate()}>
              {install.isPending ? "Installing…" : `Download and Install ${data.latest}`}
            </Button>
          </div>
        </div>
      )}
    </Frame>
  );
}
