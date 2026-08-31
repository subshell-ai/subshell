import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useWaitingCount } from "@/hooks/use-summary";
import { colors } from "@/lib/tokens";

/** Compact shell (spec §Adaptive): Sessions (waiting badge) · New · Settings. */
export default function TabsLayout() {
  const waiting = useWaitingCount();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedFg,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.bg },
        // Explicit icons: SDK 57 no longer bundles @expo/vector-icons through
        // the expo package, so bottom-tabs' default glyph font resolves to
        // nothing and every tab renders a tofu box (emulator smoke, 2026-08-31).
        tabBarIcon: ({ color, size }) => <Ionicons name="list" size={size} color={color} />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Sessions",
          tabBarBadge: waiting > 0 ? waiting : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.warning },
        }}
      />
      <Tabs.Screen
        name="new"
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="add-circle-outline" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} /> }}
      />
    </Tabs>
  );
}
