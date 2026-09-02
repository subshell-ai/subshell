import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "@/lib/tokens";
import { PushBridge } from "@/providers/push-bridge";
import { SubshellProvider } from "@/providers/subshell-provider";

/** Root: dark chrome, providers once, every route below sees useSubshell()/queries. */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SubshellProvider>
        <PushBridge />
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </SubshellProvider>
    </SafeAreaProvider>
  );
}
