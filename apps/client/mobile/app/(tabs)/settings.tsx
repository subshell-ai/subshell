import {
  COMPANY_URL,
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR,
  LICENSE_SUMMARY,
  LICENSE_URL,
} from "@internal/subshell-protocol";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmAction } from "@/components/confirm-action";
import { useApp } from "@/lib/app-state";
import { instanceMeta } from "@/lib/instances";
import { probeInstance } from "@/lib/probe";
import { makeProbeDeps } from "@/lib/probe-real";
import { colors, font, radius, touchTarget } from "@/lib/tokens";
import { biometricEnabled, requireBiometric, setBiometricEnabled } from "@/native/biometric";
import { deregisterPush, setIconBadge } from "@/native/push";
import { secureTokenStore } from "@/native/secure-token-store";
import { clientForOrigin } from "@/native/subshell-client-factory";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * Settings tab (spec §Screens): switch instance, re-probe (wsBlocked is a
 * fact about the proxy, not a preference), push-permission state, sign out.
 * Sign-out deregisters the device FIRST — a signed-out phone must stop
 * ringing (spec §Push prune contract's operator-facing twin).
 */
export default function Settings() {
  const insets = useSafeAreaInsets();
  const { client } = useSubshell();
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
    await deregisterPush(client);
    await client.signOut(); // clears the Keychain token via the injected store
    // Immediate, not left to converge via the next 401→clear() poll, which
    // never arrives if the instance went unreachable (review, #5).
    void setIconBadge(0);
    router.replace("/sign-in");
  }

  /**
   * Forget = stop ringing (server dereg), drop the Keychain token, drop the
   * registry row; if the forgotten instance was the last one, re-park on
   * Connect. (Was a 30-line inline onPress nest — review, simplification #6.)
   */
  async function forget(rec: (typeof instances)[number]) {
    await deregisterPush(clientForOrigin(rec.id));
    await secureTokenStore(rec.id)
      .clear()
      .catch(() => undefined);
    forgetInstance(rec.id);
    if (instances.length === 1 && activeId === rec.id) router.replace("/connect");
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, gap: 10 }}>
      <Text style={{ ...font("display"), color: colors.fg }}>Settings</Text>

      <Text style={{ ...font("detail"), color: colors.mutedFg, marginTop: 8 }}>Instances</Text>
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
            <Text style={{ ...font("label"), color: r.id === activeId ? colors.primary : colors.fg }}>{r.label}</Text>
            <Text style={{ ...font("caption"), color: colors.mutedFg }}>{instanceMeta(r)}</Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable onPress={() => void reprobe(r.id)} disabled={busyId !== null} hitSlop={8}>
              <Text style={{ ...font("label"), color: busyId === r.id ? colors.mutedFg : colors.primary }}>
                {busyId === r.id ? "Probing…" : "Re-probe"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() =>
                confirmAction(
                  "Forget instance?",
                  `Also forgets ${r.label}'s stored token and deregisters this phone.`,
                  "Forget",
                  () => void forget(r),
                  { destructive: true },
                )
              }
              hitSlop={8}
            >
              <Text style={{ ...font("label"), color: colors.destructive }}>Forget</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Pressable
        onPress={() => router.push("/connect")}
        style={{ minHeight: touchTarget, alignItems: "flex-start", justifyContent: "center" }}
      >
        <Text style={{ ...font("label"), color: colors.primary }}>+ Add instance</Text>
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
          <Text style={{ ...font("caption"), color: colors.mutedFg }}>
            Required by default — turning it off lets any unlock of this phone drive every pane.
          </Text>
        </View>
        <Switch
          value={bioOn ?? true}
          disabled={bioOn === null}
          onValueChange={async (next) => {
            if (next) {
              // Enabling is free; disabling must prove the biometric first.
              if (!(await requireBiometric("Disable Face ID for subshell"))) return;
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
          confirmAction(
            "Sign out?",
            "Deregisters this phone for push and clears the stored token.",
            "Sign out",
            () => void signOut(),
            { destructive: true },
          )
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
        <Text style={{ ...font("label"), color: colors.destructiveFg }}>Sign out</Text>
      </Pressable>

      {/* The phone's only licence surface. The CLIs answer `license` and the
          desktop apps have an About box; an app store build has neither, so
          without this a user who installed Subshell on their phone has no way
          to find out what they may do with it. */}
      <View style={{ marginTop: 24, gap: 4 }}>
        <Pressable
          onPress={() => void Linking.openURL(COMPANY_URL)}
          hitSlop={8}
          accessibilityRole="link"
          accessibilityLabel={`Open ${COPYRIGHT_HOLDER}`}
        >
          <Text style={{ ...font("caption"), color: colors.mutedFg }}>
            Copyright {COPYRIGHT_YEAR}{" "}
            <Text style={{ color: colors.primary, textDecorationLine: "underline" }}>{COPYRIGHT_HOLDER}</Text>
          </Text>
        </Pressable>
        <Text style={{ ...font("caption"), color: colors.mutedFg }}>{LICENSE_SUMMARY}</Text>
        <Pressable
          onPress={() => void Linking.openURL(LICENSE_URL)}
          hitSlop={8}
          accessibilityRole="link"
          accessibilityLabel="Open the full licence text"
        >
          <Text style={{ ...font("caption"), color: colors.primary, textDecorationLine: "underline" }}>
            Full licence text
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
