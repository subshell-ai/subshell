import { Input, Label, Switch } from "@internal/node-admin";
import { useEffect, useMemo, useState } from "react";
import { McpSetupSection } from "@/components/mcp-setup-section";
import { type PairRow, PairRowsEditor } from "@/components/pair-rows-editor";
import { CommandPasteField } from "@/components/presets/command-paste-field";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHarnessSchema } from "@/hooks/use-harness-schema";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import type { PresetFormValue } from "@/lib/preset-form";
import { parseEnvPaste, parseFlagsPaste } from "@/lib/preset-form";
import { buildAgentOptions } from "@/lib/subshell-compat";

/**
 * How the form is asking for env vars and flags: as the command line you'd
 * type in a terminal, or as rows. Two views of ONE set of values — neither
 * stores anything the other cannot see.
 */
export type PresetEntryMode = "paste" | "custom";

/**
 * The preset fields (agent, name, env rows, flag rows, auto-restart). The
 * form values are fully controlled by the parent so the create dialog (both
 * postures) and the edit page share one render path; the plugin list is
 * reference data and loaded here, and each section's autocomplete candidates
 * come from the selected agent's schema endpoint. Everything below the agent
 * is hidden until one is chosen (the create form starts as a single
 * question); a LOCKED agent — the nested dialog and the edit page — renders
 * as static text instead of a select. There is deliberately no
 * config-isolation control: no harness reads that flag yet, so the form never
 * offers a switch that does nothing.
 *
 * The agent list is the instance plugin catalog, greyed never hidden like
 * the launch picker's Agent select — a preset is not bound to what this
 * browser's node views happen to show, and third-party plugins must be
 * pickable, which the old harness-registry read only partly offered.
 */
export function PresetFields({
  value,
  onChange,
  lockedHarness,
  defaultEntryMode = "paste",
}: {
  value: PresetFormValue;
  onChange: (value: PresetFormValue) => void;
  /**
   * When set, the agent is this plugin id, fixed: the control renders as
   * static text. True on the edit page (a preset's agent is chosen at
   * creation and the API does not reassign it) and in the launch dialog's
   * nested create (the agent was just picked and only its presets make
   * sense there).
   */
  lockedHarness?: string;
  /**
   * Which of the two entry modes opens first. Creating starts on `paste`:
   * whoever reaches for a preset usually has the command in a terminal
   * beside them. The EDIT page passes `custom`, because opening an existing
   * preset is reading what it already is, not replacing it.
   */
  defaultEntryMode?: PresetEntryMode;
}) {
  // Loading and failure are tracked separately: "No agent installed" is only
  // honest after a load that succeeded with zero rows — claiming it while the
  // catalog is in flight (or after it failed) misreports the machine.
  const { data: pluginData, isLoading: pluginsLoading, isError: pluginsFailed } = useInstancePlugins();
  const plugins = pluginData?.plugins;
  // Same greyed-with-reason matrix and ordering as the launch picker (node-
  // side greys cannot apply here: a preset is not scoped to a node).
  const agentOptions = useMemo(() => buildAgentOptions(plugins ?? [], null), [plugins]);
  const lockedName =
    lockedHarness !== undefined ? ((plugins ?? []).find((p) => p.id === lockedHarness)?.name ?? lockedHarness) : "";
  const { data: schema } = useHarnessSchema(value.harnessId);
  const agent = (plugins ?? []).find((p) => p.id === value.harnessId);
  const agentName = agent?.name ?? (lockedHarness !== undefined ? lockedName : value.harnessId);
  // Local UI state, deliberately not part of PresetFormValue: which view you
  // last looked at is not part of the preset, and both views edit one set of
  // rows. The create dialog's mount IS its open, so this resets per open.
  const [entryMode, setEntryMode] = useState<PresetEntryMode>(defaultEntryMode);

  // One usable agent is not a decision worth forcing — pick it. The guard on
  // value.harnessId makes this self-disarming after the pick.
  useEffect(() => {
    if (lockedHarness !== undefined || value.harnessId || plugins === undefined) return;
    const only = agentOptions.filter((o) => !o.disabled);
    if (only.length === 1) onChange({ ...value, harnessId: only[0].value });
  }, [agentOptions, lockedHarness, plugins, value, onChange]);

  // Suggestions follow the selected agent; flag entries are stored as
  // "--flag example-value", so only the token itself is completable.
  const envSuggestions = useMemo(
    () => (schema?.suggestedEnv ?? []).map((e) => ({ value: e.key, detail: e.description })),
    [schema],
  );
  const flagSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; detail: string }[] = [];
    for (const f of schema?.suggestedFlags ?? []) {
      const token = f.flag.split(/\s+/)[0];
      if (token && !seen.has(token)) {
        seen.add(token);
        out.push({ value: token, detail: f.description });
      }
    }
    return out;
  }, [schema]);

  const parseEnvRows = useMemo(
    () =>
      (text: string): PairRow[] =>
        parseEnvPaste(text).map((r) => ({ first: r.key, second: r.value })),
    [],
  );
  const parseFlagRows = useMemo(
    () =>
      (text: string): PairRow[] =>
        parseFlagsPaste(text).map((r) => ({ first: r.flag, second: r.value })),
    [],
  );

  const setEnvRows = (rows: PairRow[]) =>
    onChange({ ...value, envRows: rows.map((r) => ({ key: r.first, value: r.second })) });
  const setFlagRows = (rows: PairRow[]) =>
    onChange({ ...value, flagRows: rows.map((r) => ({ flag: r.first, value: r.second })) });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {lockedHarness !== undefined ? (
          <>
            {/* Static text needs no association — the Label primitive (a real
                <label>) would bind to nothing here. Same classes it renders. */}
            <p className="font-strong text-sm leading-none">Agent</p>
            <p className="text-sm">{lockedName}</p>
            <p className="text-muted-foreground text-sm">
              An agent is chosen when a preset is created and cannot change afterwards.
            </p>
          </>
        ) : (
          <>
            <Label htmlFor="preset-harness">Agent</Label>
            <Select
              value={value.harnessId}
              // Base UI widens select values to `Value | null` (null = cleared);
              // this select can never clear, so null is dropped, not stored.
              onValueChange={(v) => v !== null && onChange({ ...value, harnessId: v })}
              // Base UI's Value prints the raw value without this map; labels
              // must match the item texts below exactly.
              items={agentOptions.map((o) => ({ value: o.value, label: o.label }))}
            >
              <SelectTrigger id="preset-harness">
                <SelectValue
                  placeholder={
                    pluginsLoading
                      ? "Loading agents…"
                      : pluginsFailed
                        ? "Couldn't load agents."
                        : // The OPTIONS, not the catalog: a network plugin is
                          // installed and is not an agent, so an instance
                          // holding one and no agent has a full catalog and an
                          // empty picker — which read as "Choose an agent"
                          // above a list with nothing in it.
                          agentOptions.length === 0
                          ? "No agent installed"
                          : "Choose an agent"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {agentOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value} disabled={o.disabled === true}>
                    {o.label}
                    {o.reason !== undefined && <span className="text-muted-foreground"> ({o.reason})</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-sm">
              Which agent CLI subshells started with this preset will run.
            </p>
            {!value.harnessId && (
              <p className="text-muted-foreground text-sm">Select an agent to see the rest of the options.</p>
            )}
          </>
        )}
      </div>
      {/* Progressive disclosure: the rest of the form is agent-dependent
          (suggestions, launch semantics), so it only appears once one is
          picked. Values typed earlier survive in the parent's state — this is
          pure rendering, not unmount-and-forget. When the agent is locked,
          harnessId is always set, so the gate is a no-op there. */}
      {value.harnessId && (
        <>
          <div className="space-y-2">
            <Label htmlFor="preset-name">Name</Label>
            <Input
              id="preset-name"
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="e.g. Fast model"
            />
          </div>
          {/* TWO VIEWS OF ONE SET OF VALUES. The rows are the state either
              way, so switching is free and lossless: paste a command and the
              row editors hold what it parsed to; edit a row and the command
              re-renders from it on the way back (CommandPasteField seeds
              itself on mount, and the panels mount one at a time).

              `Segmented` rather than a tab strip because this is the app's
              established mode switch (the tiled/list toggle, the add-subshell
              dialog, the network card's "How to connect") and this is the same
              kind of thing: two ways to say ONE thing, not two pages. Paste
              leads because whoever wants a preset usually has the command in a
              terminal beside them; the edit page flips the default, where the
              question is what this preset already is. */}
          <div className="space-y-3">
            <Segmented
              ariaLabel="How to enter env vars and flags"
              options={[
                { value: "paste", label: "Paste command" },
                { value: "custom", label: "Custom command" },
              ]}
              value={entryMode}
              onChange={setEntryMode}
            />
            {entryMode === "paste" ? (
              <CommandPasteField
                id="preset-command"
                value={value}
                onChange={onChange}
                agentName={agentName}
                agentBinary={agent?.binary}
              />
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="preset-env">Env vars</Label>
                  <PairRowsEditor
                    id="preset-env"
                    rows={value.envRows.map((r) => ({ first: r.key, second: r.value }))}
                    onChange={setEnvRows}
                    suggestions={envSuggestions}
                    firstLabel="Variable"
                    firstPlaceholder="ANTHROPIC_MODEL"
                    secondPlaceholder="sonnet"
                    pastePlaceholder={'KEY=value lines, export lines, or a JSON object:\n{"ANTHROPIC_MODEL":"sonnet"}'}
                    parsePaste={parseEnvRows}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preset-flags">Flags</Label>
                  <PairRowsEditor
                    id="preset-flags"
                    rows={value.flagRows.map((r) => ({ first: r.flag, second: r.value }))}
                    onChange={setFlagRows}
                    suggestions={flagSuggestions}
                    firstLabel="Flag"
                    firstPlaceholder="--model"
                    secondPlaceholder="value (optional)"
                    pastePlaceholder={
                      "One per line or a whole command line:\nopencode -m anthropic/claude-sonnet-4-5 --auto"
                    }
                    parsePaste={parseFlagRows}
                  />
                </div>
              </>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch
                id="preset-restart"
                checked={value.restartOnExit}
                onCheckedChange={(checked) => onChange({ ...value, restartOnExit: checked })}
              />
              <Label htmlFor="preset-restart">Auto-restart on exit</Label>
            </div>
            <p className="text-muted-foreground text-sm">
              When a subshell's agent process exits on its own, bring the subshell back up automatically, with a growing
              delay between attempts while it keeps failing. Leave off to decide manually.
            </p>
          </div>
          {schema?.mcp && <McpSetupSection mcp={schema.mcp} />}
        </>
      )}
    </div>
  );
}
