import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MoteClient } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { probeInstance } from "@/lib/probe";
import { makeProbeDeps } from "@/lib/probe-real";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { biometricEnabled, requireBiometric, setBiometricEnabled } from "@/native/biometric";
import { PUSH_TOKEN_KEY } from "@/native/push-token";
import { secureTokenStore } from "@/native/secure-token-store";
import { useMote } from "@/providers/mote-provider";

/**
 * Settings tab (spec §Screens): switch instance, re-probe (wsBlocked is a
 * fact about the proxy, not a preference), push-permission state, sign out.
 * Sign-out deregisters the device FIRST — a signed-out phone must stop
 * ringing (spec §Push prune contract's operator-facing twin).
 */
export default function Settings() {
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const { instances, activeId, setActive, forgetInstance, setWsBlocked } = useApp();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bioOn, setBioOn] = useState<boolean | null>(null);

  useEffect(() => {
    void biometricEnabled().then(setBioOn);
  }, []);

  async function reprobe(id: string) {
    setBusyId(id);
    const r = await probeInstance(id, makeProbeDeps());
    setBusyId(null);
    if (!r.ok) {
      Alert.alert("Unreachable", "Check the address and network, then try again.");
      return;
    }
    setWsBlocked(id, r.wsBlocked);
    Alert.alert(
      "Instance reachable",
      r.wsBlocked
        ? "HTTP works but WebSocket upgrades do not — the Live tab stays hidden until the proxy forwards them."
        : "HTTP and WebSocket upgrades both work.",
    );
  }

  async function pushConsent() {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) {
      Alert.alert("Notifications allowed", "If alerts still do not arrive, check Do Not Disturb.");
      return;
    }
    const res = await Notifications.requestPermissionsAsync();
    Alert.alert(
      res.granted ? "Notifications allowed" : "Notifications not allowed",
      res.granted ? "" : "Enable them in system Settings to get the bell on this phone.",
    );
  }

  async function signOut() {
    if (!client) return;
    try {
      const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
      if (token) {
        await client.forgetDevice(token);
        await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
      }
    } catch {
      /* best effort — a dead instance must not block local sign-out */
    }
    await client.signOut(); // clears the Keychain token via the injected store
    router.replace("/sign-in");
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, gap: 10 }}>
      <Text style={{ color: colors.fg, fontSize: 26, fontWeight: "700" }}>Settings</Text>

      <Text style={{ color: colors.mutedFg, fontSize: 13, marginTop: 8 }}>Instances</Text>
      {instances.map((r) => (
        <View
          key={r.id}
          style={{
            borderRadius: radius,
            borderWidth: 1,
            borderColor: r.id === activeId ? colors.primary : colors.border,
            backgroundColor: colors.card,
            padding: 12,
            gap: 8,
          }}
        >
          <Pressable onPress={() => setActive(r.id)} style={{ minHeight: touchTarget - 12, justifyContent: "center" }}>
            <Text style={{ color: r.id === activeId ? colors.primary : colors.fg, fontWeight: "600" }}>{r.label}</Text>
            <Text style={{ color: colors.mutedFg, fontSize: 12 }}>
              {r.id}
              {r.plainHttp ? " · http" : ""}
              {r.wsBlocked ? " · terminal blocked" : ""}
            </Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable onPress={() => void reprobe(r.id)} disabled={busyId !== null} hitSlop={8}>
              <Text style={{ color: busyId === r.id ? colors.mutedFg : colors.primary, fontWeight: "600" }}>
                {busyId === r.id ? "Probing…" : "Re-probe"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() =>
                Alert.alert("Forget instance?", `Also forgets ${r.label}'s stored token.`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Forget",
                    style: "destructive",
                    onPress: () => {
                      // A forgotten instance must stop ringing this phone —
                      // the operator-facing twin of the prune contract
                      // (signOut does the same, review #5).
                      void AsyncStorage.getItem(PUSH_TOKEN_KEY)
                        .then((token) =>
                          token
                            ? new MoteClient({ baseUrl: r.id, store: secureTokenStore(r.id) }).forgetDevice(token)
                            : undefined,
                        )
                        .catch(() => undefined);
                      void secureTokenStore(r.id)
                        .clear()
                        .catch(() => undefined);
                      forgetInstance(r.id);
                      if (!instances.some((x) => x.id !== r.id && x.id !== activeId) && activeId === r.id) {
                        router.replace("/connect");
                      }
                    },
                  },
                ])
              }
              hitSlop={8}
            >
              <Text style={{ color: colors.destructive, fontWeight: "600" }}>Forget</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Pressable
        onPress={() => router.push("/connect")}
        style={{ minHeight: touchTarget, alignItems: "flex-start", justifyContent: "center" }}
      >
        <Text style={{ color: colors.primary, fontWeight: "600" }}>+ Add instance</Text>
      </Pressable>

      <View
        style={{
          minHeight: touchTarget,
          marginTop: 12,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.card,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 12,
          gap: 10,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.fg }}>Face ID for terminal &amp; actions</Text>
          <Text style={{ color: colors.mutedFg, fontSize: 11 }}>
            Required by default — turning it off lets any unlock of this phone drive every pane.
          </Text>
        </View>
        <Switch
          value={bioOn ?? true}
          disabled={bioOn === null}
          onValueChange={async (next) => {
            if (next) {
              // Enabling is free; disabling must prove the biometric first.
              if (!(await requireBiometric("Disable Face ID for mote"))) return;
            }
            await setBiometricEnabled(next);
            setBioOn(next);
          }}
          trackColor={{ true: colors.primary, false: colors.border }}
        />
      </View>

      <Pressable
        onPress={() => void pushConsent()}
        style={{
          minHeight: touchTarget,
          marginTop: 12,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.card,
          alignItems: "flex-start",
          justifyContent: "center",
          paddingHorizontal: 12,
        }}
      >
        <Text style={{ color: colors.fg }}>Push notifications — check / request permission</Text>
      </Pressable>

      <Pressable
        onPress={() =>
          Alert.alert("Sign out?", "Deregisters this phone for push and clears the stored token.", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: () => void signOut() },
          ])
        }
        style={{
          minHeight: touchTarget,
          marginTop: 8,
          borderRadius: radius,
          backgroundColor: colors.destructive,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "700" }}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}
