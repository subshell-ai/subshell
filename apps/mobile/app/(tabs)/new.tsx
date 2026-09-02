import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useProfiles } from "@/hooks/use-profiles";
import { errMessage } from "@/lib/api-error";
import { anchorDecision, isSelectable, pickNodeDefault } from "@/lib/node-anchor";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { useSubshell } from "@/providers/subshell-provider";
import type { ExploreResult } from "@/types/profile";

/**
 * New-session tab (spec §Screens): profile picker, native folder sheet over
 * /api/files/explore (one level per request, recents+favourites ride along),
 * optional name and first prompt. The cookie actor unlocks the folder route —
 * exactly why the app authenticates as one (spec §Auth).
 */
export default function NewSession() {
  const insets = useSafeAreaInsets();
  const { client } = useSubshell();
  const qc = useQueryClient();
  const profiles = useProfiles();
  const nodes = useNodes();
  const [profileId, setProfileId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState("local");
  const [workingDir, setWorkingDir] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sheet, setSheet] = useState(false);
  const [dir, setDir] = useState<ExploreResult | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profileId && profiles.data?.length) setProfileId(profiles.data[0].id);
  }, [profiles.data, profileId]);

  // Pinned-profile re-anchor — mobile DELIBERATELY retains the old
  // keep-offline-pin anchor semantics (a spec 2026-09-02 pairing non-goal;
  // a mobile pass is follow-up): the selected profile's pin holds the node
  // pick until the user overrides it via the chip row, offline row included,
  // so a pinned-offline launch 409s exactly where the picker points. The web
  // has moved on: its `anchorDecision` is now `suggestDecision` and only
  // owns the pick when EARNED (pinned row visible, online, AND compatible) —
  // the divergence is intentional, do not blind-sync. A pin to `local` is
  // the default anyway — treated as no pin. Then the `pickNodeDefault`
  // re-home (still the same shape on both sides): a pick whose node vanished
  // (e.g. an admin turned off Local launching) or went unselectable is moved
  // — auto-picked when exactly one selectable option remains, else cleared
  // to "" (Start blocks until the user picks). One effect composes both,
  // anchor first.
  const pinnedNodeId = (profiles.data ?? []).find((p) => p.id === profileId)?.nodeId ?? null;
  const pinRow =
    pinnedNodeId && pinnedNodeId !== "local" ? ((nodes.data ?? []).find((n) => n.id === pinnedNodeId) ?? null) : null;
  const nodeExplicitRef = useRef(false);
  const anchoredRef = useRef<string | null>(null);
  useEffect(() => {
    const d = anchorDecision({
      pinRow,
      explicit: nodeExplicitRef.current,
      current: nodeId,
      anchoredTo: anchoredRef.current,
    });
    anchoredRef.current = d.anchoredTo;
    // Re-home only when the anchor is NOT holding — the exact web guard: a
    // pinned OFFLINE row fails `isSelectable`, but dropping it would hide the
    // very target the launch will 409 on, so the held pin is the deliberate
    // exception. Runs only once the list actually loaded: a 404s (pre-nodes)
    // instance leaves `data` undefined and the default "local" simply stands
    // (web's `if (nodes)`).
    let next = d.nodeId;
    if (!(pinRow && !nodeExplicitRef.current) && nodes.data) {
      next = pickNodeDefault(nodes.data, next);
    }
    if (next !== nodeId) setNodeId(next);
  }, [pinRow, nodeId, nodes.data]);

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
    if (!client || !profileId || !workingDir || !nodeId || busy) return;
    setBusy(true);
    try {
      const res = await client.createSession({
        profileId,
        workingDir,
        name: name.trim() || undefined,
        prompt: prompt.trim() || undefined,
        // "local" stays off the wire — omitting nodeId is the server default
        // and keeps single-machine payloads byte-identical to pre-nodes ones.
        // "" can never reach here: the guard above blocks submit (this is the
        // close of the P2-T16 "chip-less submit" debt).
        nodeId: nodeId === "local" ? undefined : nodeId,
      });
      await qc.invalidateQueries({ queryKey: ["sessions"] });
      router.replace(`/session/${res.id}`);
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
   * change. Labels/selectability mirror the web picker exactly: "Local" for
   * the control-plane host, an " — offline" suffix on a downed agent, which
   * is disabled because launching there 409s (the 409 path still covers the
   * race when the list goes stale mid-form).
   */
  const nodeOptions = nodes.data ?? [];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, gap: 16 }}>
        <Text style={{ color: colors.fg, fontSize: 26, fontWeight: "700" }}>New session</Text>

        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Profile</Text>
          {profiles.isLoading ? (
            <ActivityIndicator />
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(profiles.data ?? []).map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => {
                      // Re-tapping the already-selected profile is a no-op:
                      // clearing the explicit-pick flag without a profile
                      // CHANGE would drop the user's override and let the
                      // anchor silently re-assert on the next nodes refetch
                      // (no state change fires the anchor effect).
                      if (p.id === profileId) return;
                      // A profile change restarts the anchor game: the new
                      // profile's pin (if any) anchors until a fresh pick.
                      nodeExplicitRef.current = false;
                      setProfileId(p.id);
                    }}
                    style={{
                      padding: 10,
                      borderRadius: radius,
                      borderWidth: 1,
                      borderColor: profileId === p.id ? colors.primary : colors.border,
                      backgroundColor: colors.card,
                    }}
                  >
                    <Text style={{ color: profileId === p.id ? colors.primary : colors.fg, fontWeight: "600" }}>
                      {p.name}
                    </Text>
                    <Text style={{ color: colors.mutedFg, fontSize: 11 }}>{p.harnessId}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}
        </View>

        {nodeOptions.length > 1 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Node</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {nodeOptions.map((n) => {
                  const pickable = isSelectable(n);
                  const sel = nodeId === n.id;
                  return (
                    <Pressable
                      key={n.id}
                      onPress={() => {
                        // The user's own pick outranks the profile pin's
                        // anchor until the next profile change.
                        nodeExplicitRef.current = true;
                        setNodeId(n.id);
                      }}
                      disabled={!pickable}
                      style={{
                        padding: 10,
                        borderRadius: radius,
                        borderWidth: 1,
                        borderColor: sel ? colors.primary : colors.border,
                        backgroundColor: colors.card,
                        opacity: pickable ? 1 : 0.5,
                      }}
                    >
                      <Text style={{ color: sel ? colors.primary : colors.fg, fontWeight: "600" }}>
                        {n.kind === "local" ? "Local" : n.status === "online" ? n.name : `${n.name} — offline`}
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
        {nodeId === "" ? <Text style={{ color: colors.mutedFg, fontSize: 12 }}>Choose a node</Text> : null}

        {/* The pin is invisible only while it is not the pick: Local on a
            pinned profile means the server re-applies the pin — say so
            instead of letting the picker lie by omission (web mirror). The
            pinned row may be gone from the list; fall back to prose. */}
        {pinnedNodeId && pinnedNodeId !== "local" && nodeId === "local" ? (
          <Text style={{ color: colors.mutedFg, fontSize: 12 }}>
            {`This profile runs on ${pinRow?.name ?? "another node"} — it overrides Local.`}
          </Text>
        ) : null}

        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Working directory</Text>
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
              style={{ color: workingDir ? colors.fg : colors.mutedFg, fontFamily: "Menlo", fontSize: 13 }}
            >
              {workingDir || "Choose a folder…"}
            </Text>
          </Pressable>
        </View>

        <Field label="Name (optional)" value={name} onChangeText={setName} autoCapitalize="none" />
        <Field
          label="First prompt (optional)"
          value={prompt}
          onChangeText={setPrompt}
          multiline
          style={{ minHeight: 88, textAlignVertical: "top" }}
        />

        <PrimaryButton
          onPress={() => void start()}
          label="Start session"
          bold
          disabled={!profileId || !workingDir || !nodeId}
          busy={busy}
        />
      </ScrollView>

      <Modal visible={sheet} animationType="slide" onRequestClose={() => setSheet(false)}>
        <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 }}>
            <Pressable onPress={() => void openDir(dir?.parent ?? undefined)} hitSlop={12} disabled={!dir?.parent}>
              <Text style={{ color: dir?.parent ? colors.primary : colors.mutedFg, fontSize: 17 }}>↑</Text>
            </Pressable>
            <Text numberOfLines={1} style={{ color: colors.fg, flex: 1, fontFamily: "Menlo", fontSize: 13 }}>
              {dir?.path ?? "…"}
            </Text>
            <Pressable onPress={() => setSheet(false)} hitSlop={12}>
              <Text style={{ color: colors.mutedFg }}>Close</Text>
            </Pressable>
          </View>
          {dirError ? <Text style={{ color: colors.destructive, padding: 16 }}>{dirError}</Text> : null}
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
                      color: row.kind === "dir" ? colors.fg : colors.mutedFg,
                      fontFamily: "Menlo",
                      fontSize: 13,
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
              <Text style={{ color: colors.fg, fontWeight: "700" }}>Use this folder</Text>
            </Pressable>
          ) : null}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
