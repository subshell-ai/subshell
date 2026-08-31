import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field } from "@/components/field";
import { ApiError, errMessage } from "@/lib/api-error";
import { useApp } from "@/lib/app-state";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { useMote } from "@/providers/mote-provider";

/** Sign in as the cookie actor (spec §Auth). Rate-limit copy included. */
export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const { instances, activeId, setEmail } = useApp();
  const instance = instances.find((r) => r.id === activeId) ?? null;
  const [email, setEmailInput] = useState(instance?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setEmailInput(instance?.email ?? "");
  }, [instance?.email]);

  async function submit() {
    if (!client || busy || !email || !password) return;
    setBusy(true);
    setNote(null);
    try {
      // MoteClient.signIn stores the body token in the Keychain-backed store.
      await client.signIn(email.trim(), password);
      setEmail(email.trim());
      router.replace("/(tabs)");
    } catch (err) {
      setNote(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts — wait a minute and try again."
          : errMessage(err, "Sign-in failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <View style={{ flex: 1, padding: 24, paddingTop: insets.top + 48, gap: 16, justifyContent: "center" }}>
        <Text style={{ color: colors.fg, fontSize: 24, fontWeight: "700" }}>{instance?.label ?? "mote"}</Text>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmailInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          onSubmitEditing={() => void submit()}
          caption={note ?? undefined}
          captionColor={colors.destructive}
        />
        <Pressable
          onPress={() => void submit()}
          disabled={busy || !email || !password}
          style={{
            minHeight: touchTarget,
            borderRadius: radius,
            backgroundColor: colors.primary,
            alignItems: "center",
            justifyContent: "center",
            opacity: busy || !email || !password ? 0.5 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={{ color: colors.bg, fontWeight: "600" }}>Sign in</Text>
          )}
        </Pressable>
        <Pressable onPress={() => router.replace("/connect")} style={{ alignItems: "center", padding: 8 }}>
          <Text style={{ color: colors.mutedFg }}>Use a different instance</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
