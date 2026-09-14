import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field } from "@/components/field";
import { PrimaryButton } from "@/components/primary-button";
import { useNodes } from "@/hooks/use-nodes";
import { usePlugins } from "@/hooks/use-plugins";
import { usePresets } from "@/hooks/use-presets";
import { useSubshells } from "@/hooks/use-subshells";
import { agentDefault } from "@/lib/agent-default";
import { errMessage } from "@/lib/api-error";
import { isSelectable, nodePickSettled, nodeRunsHarness, pickNodeDefault } from "@/lib/node-pick";
import { colors, font, radius, touchTarget } from "@/lib/tokens";
import { useSubshell } from "@/providers/subshell-provider";
import type { ExploreResult } from "@/types/files";
import type { PluginView } from "@/types/plugin";

/**
 * New-subshell tab (spec 2026-09-13 §5): agent chips (the instance plugin
 * catalog, greyed-never-hidden), the chosen agent's presets as OPTIONAL chips
 * with "None" first, the launch-node picker, a native folder sheet over
 * /api/files/explore (one level per request, recents+favourites ride along),
 * and an optional first prompt. The cookie actor unlocks the folder route —
 * exactly why the app authenticates as one (spec §Auth).
 *
 * It asks for no NAME, matching the web launch form (2026-09-11): the server
 * names a subshell after its start time and the pane's own title takes over,
 * so naming one before it exists is a decision about something the user has
 * not seen. Renaming is its own act on the subshell itself.
 *
 * The mirror convention: this screen, `src/lib/node-pick.ts` and
 * `src/lib/agent-default.ts` mirror the web
 * `apps/server/web/src/components/subshell-picker/new-subshell-form.tsx` of
 * the same shape — change one, change both.
 */
export default function NewSubshell() {
  const insets = useSafeAreaInsets();
  const { client } = useSubshell();
  const qc = useQueryClient();
  const plugins = usePlugins();
  const presets = usePresets();
  const nodes = useNodes();
  const subshells = useSubshells();
  // The launch is harness-first; the preset is optional and null means "None".
  const [harnessId, setHarnessId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState("local");
  const [workingDir, setWorkingDir] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sheet, setSheet] = useState(false);
  const [dir, setDir] = useState<ExploreResult | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Whether the SELECTED node reports a harness's binary installed. The
   * node's per-harness inventory is the crossing of the instance catalog and
   * that machine's detect (spec 2026-09-10). A node row carrying no
   * `harnesses` (older server) reads as unknown — unknown blocks nothing, the
   * same `!== false` posture as `canLaunch`, and the 409 at submit covers the
   * real gap.
   */
  const installedOnNode = useCallback(
    (id: string): boolean => {
      const node = (nodes.data ?? []).find((n) => n.id === nodeId);
      // No row for the current pick (none chosen, or a node that vanished)
      // reads as unknown, which blocks nothing — same `!== false` posture as
      // `canLaunch`. `nodeRunsHarness` owns the rest of the rule, so the
      // agent chips and the node chips cannot disagree about one pairing.
      return node === undefined || nodeRunsHarness(node, id);
    },
    [nodes.data, nodeId],
  );

  /** Chip greying + the default rule's conjunction, defined exactly once (spec §5). */
  const agentUsable = (p: PluginView): boolean => p.installed && p.enabled && !p.broken && installedOnNode(p.id);

  // Default agent (spec §5): once, while nothing is picked — the user's
  // choice always outranks the rule, including a pick that later goes
  // uninstalled on a node switch (the server 409 stays the backstop).
  // `nodes.isFetched` gates the node-blocked term: a pre-nodes instance 404s
  // the route, `data` stays undefined, and the rule then runs with an
  // all-unknown inventory exactly as it did before nodes existed. The
  // subshells list is gated stricter, inside `agentDefault` (ruled
  // 2026-09-13): unanswered — pending or errored, data undefined — must not
  // fill; answered-EMPTY is a real answer, and the first-usable tier stands.
  // `nodePickSettled` is the third gate and the reason the two effects can
  // stay separate here: the agent default reads a PER-NODE inventory, so it
  // must not fill while the re-home below is still about to move the node
  // under it (see that helper for the failure it prevents).
  useEffect(() => {
    if (harnessId !== null || !nodes.isFetched || !nodePickSettled(nodes.data, nodeId)) return;
    const pick = agentDefault(plugins.data, installedOnNode, subshells.data);
    if (pick) setHarnessId(pick);
  }, [harnessId, nodes.isFetched, nodes.data, nodeId, plugins.data, subshells.data, installedOnNode]);

  // The chosen agent's presets — the row exists only when there is at least
  // one (spec §5: "a new account has zero presets and the row would offer
  // only None"). Changing the agent resets the preset to None.
  const agentPresets = useMemo(
    () => (presets.data ?? []).filter((p) => p.harnessId === harnessId),
    [presets.data, harnessId],
  );

  // Coherence guard (web's one-liner in new-subshell-form.tsx): a held
  // preset that has vanished from the chosen agent's list — deleted on
  // another device — falls back to None instead of riding the submit into a
  // 404. Only an answered list may clear: while presets are still loading,
  // absence proves nothing. (Changing the agent already resets the pick, so
  // web's harness-mismatch branch is unreachable here by construction.)
  useEffect(() => {
    if (presetId === null || !presets.data) return;
    if (!agentPresets.some((p) => p.id === presetId)) setPresetId(null);
  }, [presetId, presets.data, agentPresets]);

  // Node re-home (web parity): a pick whose node vanished (e.g. an admin
  // turned off Local launching) or went unselectable is moved — auto-picked
  // when exactly one selectable option remains, else cleared to "" (Start
  // blocks until the user picks). Runs only once the list actually loaded: a
  // 404s (pre-nodes) instance leaves `data` undefined and the default "local"
  // simply stands (web's `if (nodes)`). The pin step is gone (spec
  // 2026-09-13) — nothing outranks the user's pick any more.
  useEffect(() => {
    if (!nodes.data) return;
    const next = pickNodeDefault(nodes.data, nodeId);
    if (next !== nodeId) setNodeId(next);
  }, [nodeId, nodes.data]);

  async function openDir(path?: string) {
    if (!client || dirBusy) return;
    setDirBusy(true);
    setDirError(null);
    try {
      setDir(await client.filesExplore(path));
    } catch (err) {
      setDirError(errMessage(err, "Cannot read that folder"));
    } finally {
      setDirBusy(false);
    }
  }

  async function start() {
    // Same shape as the web form's canSubmit: agent + working dir + a node.
    if (!client || !harnessId || !workingDir || !nodeId || busy) return;
    setBusy(true);
    try {
      const res = await client.createSubshell({
        harnessId,
        presetId,
        workingDir,
        prompt: prompt.trim() || undefined,
        // "local" stays off the wire — omitting nodeId is the server default
        // and keeps single-machine payloads byte-identical to pre-nodes ones.
        // "" can never reach here: the guard above blocks submit (this is the
        // close of the P2-T16 "chip-less submit" debt).
        nodeId: nodeId === "local" ? undefined : nodeId,
      });
      await qc.invalidateQueries({ queryKey: ["subshells"] });
      router.replace(`/subshell/${res.id}`);
    } catch (err) {
      Alert.alert("Could not start", errMessage(err, "Request failed"));
    } finally {
      setBusy(false);
    }
  }

  /** Favourites + recents select; bare dirs descend. The footer button picks the current dir. */
  const sheetRows = useMemo(() => {
    if (!dir) return [];
    return [
      ...dir.favorites.map((f) => ({ kind: "fav" as const, path: f.path, label: f.label ?? f.path })),
      ...dir.recent.map((f) => ({ kind: "recent" as const, path: f.path, label: f.label ?? f.path })),
      ...dir.entries
        .filter((e) => e.kind === "dir")
        .map((e) => ({ kind: "dir" as const, path: e.path, label: e.name })),
    ];
  }, [dir]);

  /**
   * The launch picker (spec §9): every visible node (ANY share grants launch).
   * Hidden unless there is a real choice — one node (or a pre-nodes instance
   * where the route 404s) means `local`, and single-machine users see no
   * change. Labels/selectability mirror the web picker: the node's own NAME
   * (the control-plane row is admin-named and defaults to "Server" — nothing
   * rendered derives from the id), an " — offline" suffix on a downed agent,
   * which is disabled because launching there 409s (the 409 path still
   * covers the race when the list goes stale mid-form). A node that cannot
   * run the agent now held is greyed too, as web's `buildNodeOptions` does
   * it — without that, the incompatible pair stayed reachable by tapping
   * node-then-agent.
   */
  const nodeOptions = nodes.data ?? [];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, gap: 16 }}>
        <Text style={{ ...font("display"), color: colors.fg }}>New subshell</Text>

        <View style={{ gap: 6 }}>
          <Text style={{ ...font("detail"), color: colors.mutedFg }}>Agent</Text>
          {plugins.isLoading ? (
            <ActivityIndicator />
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(plugins.data ?? []).map((p) => {
                  const usable = agentUsable(p);
                  const sel = harnessId === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => {
                        // A fresh agent resets the preset (spec §5) — the old
                        // one belongs to a different harness. Re-tapping the
                        // selected chip stays a no-op.
                        if (p.id === harnessId) return;
                        setHarnessId(p.id);
                        setPresetId(null);
                      }}
                      disabled={!usable}
                      // Selection and greying are carried by border colour and
                      // opacity, which a screen reader cannot see. The state
                      // props are the only announcement of either — and the
                      // greyed chips are new in this cut, so the disabled half
                      // had no announcement at all before.
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel, disabled: !usable }}
                      style={{
                        padding: 10,
                        borderRadius: radius,
                        borderWidth: 1,
                        borderColor: sel ? colors.primary : colors.border,
                        backgroundColor: colors.card,
                        opacity: usable ? 1 : 0.5,
                      }}
                    >
                      <Text style={{ ...font("label"), color: sel ? colors.primary : colors.fg }}>
                        {p.icon ? `${p.icon} ` : ""}
                        {p.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>

        {harnessId && agentPresets.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ ...font("detail"), color: colors.mutedFg }}>Preset</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  onPress={() => setPresetId(null)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: presetId === null }}
                  style={{
                    padding: 10,
                    borderRadius: radius,
                    borderWidth: 1,
                    borderColor: presetId === null ? colors.primary : colors.border,
                    backgroundColor: colors.card,
                  }}
                >
                  <Text style={{ ...font("label"), color: presetId === null ? colors.primary : colors.fg }}>None</Text>
                </Pressable>
                {agentPresets.map((pr) => {
                  const sel = presetId === pr.id;
                  return (
                    <Pressable
                      key={pr.id}
                      onPress={() => setPresetId(pr.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel }}
                      style={{
                        padding: 10,
                        borderRadius: radius,
                        borderWidth: 1,
                        borderColor: sel ? colors.primary : colors.border,
                        backgroundColor: colors.card,
                      }}
                    >
                      <Text style={{ ...font("label"), color: sel ? colors.primary : colors.fg }}>{pr.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        ) : null}

        {nodeOptions.length > 1 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ ...font("detail"), color: colors.mutedFg }}>Node</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {nodeOptions.map((n) => {
                  // Both halves of the pairing, as web does it
                  // (`buildNodeOptions`): the node's own state AND whether it
                  // can run the agent now held. Greying only the first left
                  // the incompatible pair reachable by tapping node-then-
                  // agent, where the agent chips' greying never applies.
                  const pickable = isSelectable(n) && nodeRunsHarness(n, harnessId);
                  const sel = nodeId === n.id;
                  return (
                    <Pressable
                      key={n.id}
                      onPress={() => setNodeId(n.id)}
                      disabled={!pickable}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel, disabled: !pickable }}
                      style={{
                        padding: 10,
                        borderRadius: radius,
                        borderWidth: 1,
                        borderColor: sel ? colors.primary : colors.border,
                        backgroundColor: colors.card,
                        opacity: pickable ? 1 : 0.5,
                      }}
                    >
                      <Text style={{ ...font("label"), color: sel ? colors.primary : colors.fg }}>
                        {/* `n.name`, never a word derived from the id: the
                            control-plane row is admin-named (root AGENTS.md,
                            spec 2026-09-08) and defaults to "Server", so the
                            hardcoded "Local" that used to sit here showed
                            every other user a name for a machine that is not
                            theirs — and survived a rename. */}
                        {n.kind === "local" || n.status === "online" ? n.name : `${n.name} — offline`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        ) : null}

        {/* No-pick state (web `pickNodeDefault` → ""): the pick vanished and
            no single option could be chosen for the user. Mirrors web's
            "Choose a node" placeholder — here as a hint line under the chip
            row (which can be hidden while ≤1 node is listed), because Start
            is blocked until a pick happens. */}
        {nodeId === "" ? <Text style={{ ...font("detail"), color: colors.mutedFg }}>Choose a node</Text> : null}

        <View style={{ gap: 6 }}>
          <Text style={{ ...font("detail"), color: colors.mutedFg }}>Working directory</Text>
          <Pressable
            onPress={() => {
              setSheet(true);
              void openDir(workingDir || undefined);
            }}
            style={{
              minHeight: touchTarget,
              borderRadius: radius,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.card,
              alignItems: "flex-start",
              justifyContent: "center",
              paddingHorizontal: 12,
            }}
          >
            <Text
              numberOfLines={1}
              style={{ ...font("detail"), color: workingDir ? colors.fg : colors.mutedFg, fontFamily: "Menlo" }}
            >
              {workingDir || "Choose a folder…"}
            </Text>
          </Pressable>
        </View>

        <Field
          label="First prompt (optional)"
          value={prompt}
          onChangeText={setPrompt}
          multiline
          style={{ minHeight: 88, textAlignVertical: "top" }}
        />

        <PrimaryButton
          onPress={() => void start()}
          label="Start subshell"
          disabled={!harnessId || !workingDir || !nodeId}
          busy={busy}
        />
      </ScrollView>

      <Modal visible={sheet} animationType="slide" onRequestClose={() => setSheet(false)}>
        <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 }}>
            <Pressable onPress={() => void openDir(dir?.parent ?? undefined)} hitSlop={12} disabled={!dir?.parent}>
              <Text style={{ ...font("label"), color: dir?.parent ? colors.primary : colors.mutedFg }}>↑</Text>
            </Pressable>
            <Text numberOfLines={1} style={{ ...font("detail"), color: colors.fg, flex: 1, fontFamily: "Menlo" }}>
              {dir?.path ?? "…"}
            </Text>
            <Pressable onPress={() => setSheet(false)} hitSlop={12}>
              <Text style={{ ...font("label"), color: colors.mutedFg }}>Close</Text>
            </Pressable>
          </View>
          {dirError ? (
            <Text style={{ ...font("body"), color: colors.destructive, padding: 16 }}>{dirError}</Text>
          ) : null}
          {dirBusy && !dir ? (
            <View style={{ padding: 24, alignItems: "center" }}>
              <ActivityIndicator />
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }}>
              {sheetRows.map((row) => (
                <Pressable
                  key={`${row.kind}-${row.path}`}
                  onPress={() => {
                    if (row.kind === "dir") void openDir(row.path);
                    else {
                      setWorkingDir(row.path);
                      setSheet(false);
                    }
                  }}
                  style={{
                    minHeight: touchTarget,
                    justifyContent: "center",
                    paddingHorizontal: 16,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text
                    style={{
                      ...font("detail"),
                      color: row.kind === "dir" ? colors.fg : colors.mutedFg,
                      fontFamily: "Menlo",
                    }}
                  >
                    {row.kind === "fav" ? "★ " : row.kind === "recent" ? "🕘 " : ""}
                    {row.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          {dir ? (
            <Pressable
              onPress={() => {
                setWorkingDir(dir.path);
                setSheet(false);
              }}
              style={{
                margin: 16,
                minHeight: touchTarget,
                borderRadius: radius,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ ...font("label"), color: colors.fg }}>Use this folder</Text>
            </Pressable>
          ) : null}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
