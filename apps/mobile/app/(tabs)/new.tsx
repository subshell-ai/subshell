import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import { useProfiles } from "@/hooks/use-profiles";
import { errMessage } from "@/lib/api-error";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { useMote } from "@/providers/mote-provider";
import type { ExploreResult } from "@/types/profile";

/**
 * New-session tab (spec §Screens): profile picker, native folder sheet over
 * /api/files/explore (one level per request, recents+favourites ride along),
 * optional name and first prompt. The cookie actor unlocks the folder route —
 * exactly why the app authenticates as one (spec §Auth).
 */
export default function NewSession() {
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const qc = useQueryClient();
  const profiles = useProfiles();
  const [profileId, setProfileId] = useState<string | null>(null);
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
    if (!client || !profileId || !workingDir || busy) return;
    setBusy(true);
    try {
      const res = await client.createSession({
        profileId,
        workingDir,
        name: name.trim() || undefined,
        prompt: prompt.trim() || undefined,
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
                    onPress={() => setProfileId(p.id)}
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
          disabled={!profileId || !workingDir}
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
