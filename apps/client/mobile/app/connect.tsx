import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmAction } from "@/components/confirm-action";
import { Field } from "@/components/field";
import { PrimaryButton } from "@/components/primary-button";
import { useApp } from "@/lib/app-state";
import { InvalidInstanceUrl, normalizeInstanceOrigin } from "@/lib/instance-url";
import { instanceMeta } from "@/lib/instances";
import { type ProbeResult, probeInstance } from "@/lib/probe";
import { makeProbeDeps } from "@/lib/probe-real";
import { colors, font, radius, touchTarget } from "@/lib/tokens";

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
      <Text style={{ ...font("display"), color: colors.fg }}>subshell</Text>
      <Text style={{ ...font("body"), color: colors.mutedFg }}>
        The companion for your own instance. Type its address once.
      </Text>
      <Field
        label="Instance address"
        placeholder="subshell.example.com"
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
        <Text style={{ ...font("detail"), color: colors.warning }}>
          Plain HTTP: your token will cross the network in the clear.
        </Text>
      ) : null}
      <PrimaryButton onPress={() => void save()} label="Connect" disabled={input.trim().length === 0} busy={busy} />

      {instances.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ ...font("detail"), color: colors.mutedFg }}>Saved instances</Text>
          {instances.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => {
                setActive(r.id);
                router.push("/sign-in");
              }}
              onLongPress={() =>
                confirmAction("Forget instance?", r.id, "Forget", () => forgetInstance(r.id), { destructive: true })
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
              <Text style={{ ...font("label"), color: colors.fg }}>{r.label}</Text>
              <Text style={{ ...font("detail"), color: colors.mutedFg }}>{instanceMeta(r)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={{ ...font("detail"), color: colors.mutedFg }}>
        Private hosts (LAN/CGNAT/.local) default to http; everything else upgrades to https.
      </Text>
    </ScrollView>
  );
}
