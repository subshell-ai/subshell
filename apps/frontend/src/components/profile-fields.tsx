import { useEffect, useMemo } from "react";
import { McpSetupSection } from "@/components/mcp-setup-section";
import { type PairRow, PairRowsEditor } from "@/components/pair-rows-editor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useHarnessSchema } from "@/hooks/use-harness-schema";
import { useHarnesses } from "@/hooks/use-harnesses";
import { useNodes } from "@/hooks/use-nodes";
import { nodeOptionLabel } from "@/lib/node-label";
import { type ProfileFormValue, parseEnvPaste, parseFlagsPaste } from "@/lib/profile-form";

/**
 * The profile fields (harness, name, env rows, flag rows, auto-restart). The
 * form values are fully controlled by the parent so the create form and the
 * edit page share one render path; the harness list is reference data and
 * loaded here, and each section's autocomplete candidates come from the
 * selected harness's schema endpoint. Everything below the harness select is
 * hidden until one is chosen (the create form starts as a single question; on
 * the edit page the harness is always set, so nothing is hidden). There is
 * deliberately no
 * config-isolation control: no harness reads that flag yet, so the form never
 * offers a switch that does nothing.
 */
export function ProfileFields({
  value,
  onChange,
  lockHarness = false,
}: {
  value: ProfileFormValue;
  onChange: (value: ProfileFormValue) => void;
  /**
   * True on the edit page: a profile's harness is chosen at creation and the
   * API does not reassign it afterwards.
   */
  lockHarness?: boolean;
}) {
  // Disabled harnesses are not presented to profiles at all (the server
  // refuses them too); among the enabled ones, uninstalled entries still
  // appear greyed out so the list explains itself. Loading and failure are
  // tracked separately: "No harness enabled" is only honest after a load
  // that succeeded with zero enabled harnesses — claiming it while the
  // registry is in flight (or after it failed) is the first thing a fresh
  // wizard user's profile step used to say.
  const { data: allHarnesses, isLoading: harnessesLoading, isError: harnessesFailed } = useHarnesses();
  const harnesses = useMemo(() => allHarnesses?.filter((h) => h.enabled), [allHarnesses]);
  const { data: schema } = useHarnessSchema(value.harnessId);
  // Node pin options (spec 2026-08-31 §6.2): every node VISIBLE to the caller
  // — any share level may host a profile's sessions, so this is the plain
  // registry list; the server re-validates visibility at save time (404 for
  // an invisible pin).
  const { data: nodeData } = useNodes();
  const nodes = nodeData?.nodes ?? [];

  // Dead-pin fallback: a profile can outlive its pin (node deleted, or the
  // share revoked since). An id missing from the caller's visible list is
  // unselectable in the picker AND refused at save (the server re-validates
  // visibility), so normalize the form value to "" — the "Any node" sentinel
  // — once the list has answered. Editing any other field then PUTs
  // `nodeId: null` instead of the ghost id. Only judged after a successful
  // load: against the in-flight empty list this would unpin live pins.
  useEffect(() => {
    if (!nodeData || !value.nodeId) return;
    if (!nodeData.nodes.some((n) => n.id === value.nodeId)) onChange({ ...value, nodeId: "" });
  }, [nodeData, value, onChange]);

  // One usable harness is not a decision worth forcing — pick it. The
  // guard on value.harnessId makes this self-disarming after the pick.
  useEffect(() => {
    if (lockHarness || value.harnessId || !harnesses) return;
    const only = harnesses.filter((h) => h.installed);
    if (only.length === 1) onChange({ ...value, harnessId: only[0].id });
  }, [harnesses, lockHarness, value, onChange]);

  // Suggestions follow the selected harness; flag entries are stored as
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
        <Label htmlFor="profile-harness">Harness</Label>
        <Select
          value={value.harnessId}
          // Base UI widens select values to `Value | null` (null = cleared);
          // this select can never clear, so null is dropped, not stored.
          onValueChange={(v) => v !== null && onChange({ ...value, harnessId: v })}
          disabled={lockHarness}
          // Base UI's Value prints the raw value without this map; labels
          // must match the item texts below exactly.
          items={(harnesses ?? []).map((h) => ({
            value: h.id,
            label: h.installed ? h.name : `${h.name} — not installed`,
          }))}
        >
          <SelectTrigger id="profile-harness">
            <SelectValue
              placeholder={
                harnessesLoading
                  ? "Loading harnesses…"
                  : harnessesFailed
                    ? "Couldn't load harnesses."
                    : (harnesses ?? []).length === 0
                      ? "No harness enabled"
                      : "Choose a harness"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(harnesses ?? []).map((h) => (
              <SelectItem key={h.id} value={h.id} disabled={!h.installed}>
                {h.name}
                {!h.installed && <span className="text-muted-foreground"> — not installed</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-sm">
          {lockHarness
            ? "A profile's harness is set when it is created and cannot change afterwards."
            : "Which agent CLI sessions started from this profile will run."}
        </p>
        {!value.harnessId && !lockHarness && (
          <p className="text-muted-foreground text-sm">Select a harness to see the rest of the options.</p>
        )}
      </div>
      {/* Progressive disclosure: the rest of the form is harness-dependent
          (suggestions, launch semantics), so it only appears once a harness is
          picked. Values typed earlier survive in the parent's state — this is
          pure rendering, not unmount-and-forget. On the edit page harnessId is
          always set, so the gate is a no-op there. */}
      {value.harnessId && (
        <>
          <div className="space-y-2">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="e.g. Default"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-node">Node</Label>
            <Select
              // "any" is the picker sentinel for "no pin" — the form state
              // keeps "" and the wire gets null (see profile-form.ts).
              value={value.nodeId || "any"}
              onValueChange={(v) => v !== null && onChange({ ...value, nodeId: v === "any" ? "" : v })}
              items={[
                { value: "any", label: "Any node (default)" },
                ...nodes.map((n) => ({
                  value: n.id,
                  label: nodeOptionLabel(n, "Local (this host)"),
                })),
              ]}
            >
              <SelectTrigger id="profile-node">
                <SelectValue placeholder="Any node (default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any node (default)</SelectItem>
                {nodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {nodeOptionLabel(n, "Local (this host)")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-sm">
              Pins sessions started from this profile to one machine. The pin is honoured at launch — if the pinned node
              is offline, starting a session with this profile fails until it is back.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-env">Env vars</Label>
            <PairRowsEditor
              id="profile-env"
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
            <Label htmlFor="profile-flags">Flags</Label>
            <PairRowsEditor
              id="profile-flags"
              rows={value.flagRows.map((r) => ({ first: r.flag, second: r.value }))}
              onChange={setFlagRows}
              suggestions={flagSuggestions}
              firstLabel="Flag"
              firstPlaceholder="--model"
              secondPlaceholder="value (optional)"
              pastePlaceholder={"One per line or a whole command line:\nopencode -m anthropic/claude-sonnet-4-5 --auto"}
              parsePaste={parseFlagRows}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch
                id="profile-restart"
                checked={value.restartOnExit}
                onCheckedChange={(checked) => onChange({ ...value, restartOnExit: checked })}
              />
              <Label htmlFor="profile-restart">Auto-restart on exit</Label>
            </div>
            <p className="text-muted-foreground text-sm">
              When a session's harness process exits on its own, bring the session back up automatically — with a
              growing delay between attempts while it keeps failing. Leave off to decide manually.
            </p>
          </div>
          {schema?.mcp && <McpSetupSection mcp={schema.mcp} />}
        </>
      )}
    </div>
  );
}
