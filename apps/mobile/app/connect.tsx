import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field } from "@/components/field";
import { useApp } from "@/lib/app-state";
import { InvalidInstanceUrl, normalizeInstanceOrigin } from "@/lib/instance-url";
import { type ProbeResult, probeInstance } from "@/lib/probe";
import { makeProbeDeps } from "@/lib/probe-real";
import { colors, radius, touchTarget } from "@/lib/tokens";

/** Connect screen (spec §Screens): type/paste an origin, manage the list. */
export default function Connect() {
  const insets = useSafeAreaInsets();
  const { instances, addInstance, forgetInstance, setActive, setWsBlocked } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; color: string } | null>(null);

  let plainHttp = false;
  try {
    plainHttp = normalizeInstanceOrigin(input).startsWith("http://");
  } catch {
    /* incomplete typing — no hint until it parses */
  }

  async function save() {
    if (busy) return;
    let origin: string;
    try {
      origin = normalizeInstanceOrigin(input);
    } catch (err) {
      setNote({
        text: err instanceof InvalidInstanceUrl ? err.message : "Not a valid address",
        color: colors.destructive,
      });
      return;
    }
    setBusy(true);
    setNote(null);
    const result: ProbeResult = await probeInstance(origin, makeProbeDeps());
    setBusy(false);
    if (!result.ok) {
      setNote({ text: "Could not reach that instance — check the address and network", color: colors.destructive });
      return;
    }
    const rec = addInstance(input);
    setWsBlocked(rec.id, result.wsBlocked);
    if (result.needsSetup) {
      Alert.alert("Needs setup", "Open this instance in a browser to finish setup, then sign in here.");
    }
    router.replace("/sign-in");
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: 24, paddingTop: insets.top + 32, gap: 16, minHeight: "100%" }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: colors.fg, fontSize: 28, fontWeight: "700" }}>mote</Text>
      <Text style={{ color: colors.mutedFg, fontSize: 15 }}>
        The companion for your own instance. Type its address once.
      </Text>
      <Field
        label="Instance address"
        placeholder="mote.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={input}
        onChangeText={setInput}
        onSubmitEditing={() => void save()}
        caption={note?.text}
        captionColor={note?.color ?? colors.destructive}
      />
      {plainHttp ? (
        <Text style={{ color: colors.warning, fontSize: 12 }}>
          Plain HTTP: your token will cross the network in the clear.
        </Text>
      ) : null}
      <Pressable
        onPress={() => void save()}
        disabled={busy || input.trim().length === 0}
        style={{
          minHeight: touchTarget,
          borderRadius: radius,
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
          opacity: busy || input.trim().length === 0 ? 0.5 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text style={{ color: colors.bg, fontWeight: "600" }}>Connect</Text>
        )}
      </Pressable>

      {instances.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Saved instances</Text>
          {instances.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => {
                setActive(r.id);
                router.push("/sign-in");
              }}
              onLongPress={() =>
                Alert.alert("Forget instance?", r.id, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Forget", style: "destructive", onPress: () => forgetInstance(r.id) },
                ])
              }
              style={{
                minHeight: touchTarget,
                padding: 12,
                borderRadius: radius,
                backgroundColor: colors.card,
                borderWidth: 1,
                borderColor: colors.border,
                gap: 2,
              }}
            >
              <Text style={{ color: colors.fg, fontWeight: "500" }}>{r.label}</Text>
              <Text style={{ color: colors.mutedFg, fontSize: 12 }}>
                {r.id}
                {r.plainHttp ? " · http" : ""}
                {r.wsBlocked ? " · terminal blocked" : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={{ color: colors.mutedFg, fontSize: 11 }}>
        Private hosts (LAN/CGNAT/.local) default to http; everything else upgrades to https.
      </Text>
    </ScrollView>
  );
}
