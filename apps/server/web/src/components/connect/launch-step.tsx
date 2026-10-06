import { Bot, SlidersHorizontal, TerminalSquare } from "lucide-react";
import type { SshRuntimeHarnessEntry, SshRuntimeSessionView } from "@/lib/ssh-runtime";
import { destinationLabel } from "@/lib/ssh-runtime";
import type { PresetRow } from "@/types/preset";

/**
 * The wizard's last step: WHAT to open in the chosen folder. Three row kinds,
 * one list, the same call signature for all:
 *
 * - **Terminal**: always available (the destination's shell needs nothing but
 *   the runtime).
 * - **Harnesses**: the destination's detected binaries (the detect mirror;
 *   `installed` rows only, and the terminal harness rides its own row above).
 *   A presetless harness launch, the same launch an unnamed create performs.
 * - **Presets**: the caller's saved presets whose harness DETECTED as
 *   installed here. A preset for a harness the destination lacks stays hidden
 *   - the row would only fail, and hiding names nothing the operator needs.
 *
 * `detecting`/`detectError` surface the round trip: while it is in flight or
 * failed, only the terminal row is offered (and a failure says so in one
 * quiet sentence - the mirror is cacheable, a retry is a button).
 */

/** What a row asks for: the terminal, a harness presetless, or a preset. */
export type LaunchPick =
  | { kind: "terminal" }
  | { kind: "harness"; harnessId: string }
  | { kind: "preset"; harnessId: string; presetId: string };

/** One harness the destination has (the terminal harness never doubles as a row here). */
function isSelectableHarness(h: SshRuntimeHarnessEntry): boolean {
  return h.installed && h.harnessId !== "terminal";
}

/** The preset rows: the caller's presets whose harness detected installed there. */
function selectablePresets(
  presets: PresetRow[],
  harnesses: SshRuntimeHarnessEntry[],
): { preset: PresetRow; harnessName: string }[] {
  const installed = harnesses.filter(isSelectableHarness);
  return presets
    .filter((p) => p.harnessId !== "terminal")
    .map((p) => ({ preset: p, harnessName: installed.find((h) => h.harnessId === p.harnessId)?.harnessName ?? null }))
    .filter((r): r is { preset: PresetRow; harnessName: string } => r.harnessName !== null);
}

export function LaunchStep({
  session,
  cwd,
  busy,
  harnesses,
  presets,
  detecting,
  detectError,
  onDetect,
  onPick,
}: {
  session: SshRuntimeSessionView;
  /** The folder chosen in the browser above this step. */
  cwd: string;
  /** A launch is in flight; the rows are inert until it answers. */
  busy: boolean;
  /** The destination's harness mirror (empty until the first detect). */
  harnesses: SshRuntimeHarnessEntry[];
  /** The caller's presets; only those on installed harnesses become rows. */
  presets: PresetRow[];
  /** The detect round trip is in flight. */
  detecting: boolean;
  /** The detect round trip failed (rows fall back to terminal-only). */
  detectError: boolean;
  /** Re-ask the destination. */
  onDetect: () => void;
  /** The chosen entry: terminal, a detected harness, or an installed preset. */
  onPick: (pick: LaunchPick) => void;
}) {
  const harnessRows = harnesses.filter(isSelectableHarness);
  const presetRows = selectablePresets(presets, harnesses);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-strong text-label">Open in this folder</p>
        <button
          type="button"
          onClick={onDetect}
          disabled={detecting}
          className="cursor-pointer text-detail text-muted-foreground underline-offset-4 hover:underline disabled:pointer-events-none"
        >
          {detecting ? "Checking…" : "Check installed agents"}
        </button>
      </div>
      {detectError && !detecting && (
        <p className="text-detail text-muted-foreground">
          The destination could not say which agents it has installed. The terminal still opens; retry when the runtime
          there is updated.
        </p>
      )}
      {/* A real button, not a click-handler div: these are the step's only
          controls, and a control has to take the keyboard. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => onPick({ kind: "terminal" })}
        className="w-full cursor-pointer rounded-md border p-4 text-left transition-colors hover:bg-accent disabled:pointer-events-none"
      >
        <div className="flex items-center gap-3">
          <TerminalSquare className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-strong text-label">Terminal</p>
            {/* Two sentences, the quiet tier; the path above is the data this row acts on. */}
            <p className="truncate text-detail text-muted-foreground">
              An interactive shell on <span className="font-mono">{destinationLabel(session)}</span>, starting in{" "}
              <span className="font-mono">{cwd}</span>.
            </p>
          </div>
          {busy && <span className="text-detail text-muted-foreground">Opening…</span>}
        </div>
      </button>
      {harnessRows.map((h) => (
        <button
          key={h.harnessId}
          type="button"
          disabled={busy}
          onClick={() => onPick({ kind: "harness", harnessId: h.harnessId })}
          className="w-full cursor-pointer rounded-md border p-4 text-left transition-colors hover:bg-accent disabled:pointer-events-none"
        >
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-strong text-label">{h.harnessName}</p>
              <p className="truncate text-detail text-muted-foreground">
                {h.rawVersion ? `${h.rawVersion} on this destination.` : "Installed on this destination."}
              </p>
            </div>
            {busy && <span className="text-detail text-muted-foreground">Opening…</span>}
          </div>
        </button>
      ))}
      {presetRows.map(({ preset, harnessName }) => (
        <button
          key={preset.id}
          type="button"
          disabled={busy}
          onClick={() => onPick({ kind: "preset", harnessId: preset.harnessId, presetId: preset.id })}
          className="w-full cursor-pointer rounded-md border p-4 text-left transition-colors hover:bg-accent disabled:pointer-events-none"
        >
          <div className="flex items-center gap-3">
            <SlidersHorizontal className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-strong text-label">{preset.name}</p>
              <p className="truncate text-detail text-muted-foreground">
                {harnessName} preset{preset.description ? `: ${preset.description}` : "."}
              </p>
            </div>
            {busy && <span className="text-detail text-muted-foreground">Opening…</span>}
          </div>
        </button>
      ))}
    </div>
  );
}
