import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useApp } from "@/lib/app-state";
import { secureTokenStore } from "@/native/secure-token-store";

/**
 * The guard (spec §Auth): routes to the right step from what exists —
 * no instance → Connect; instance but no Keychain token → Sign-in; both →
 * the tab shell. Sign-in mid-session (after a 401) is pushed over the stack
 * by the provider, not routed through here.
 */
export default function Guard() {
  const { hydrated, activeId } = useApp();
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  useEffect(() => {
    if (!activeId) {
      setHasToken(false);
      return;
    }
    void secureTokenStore(activeId)
      .get()
      .then((t) => setHasToken(Boolean(t)))
      .catch(() => setHasToken(false));
  }, [activeId]);

  if (!hydrated || hasToken === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!activeId) return <Redirect href="/connect" />;
  if (!hasToken) return <Redirect href="/sign-in" />;
  return <Redirect href="/(tabs)" />;
}
