import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RunProvider } from '../state'
import { colors } from '../ui'

export default function RootLayout () {
  return (
    <SafeAreaProvider>
      <RunProvider>
        <StatusBar style='light' />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen name='(tabs)' />
        </Stack>
      </RunProvider>
    </SafeAreaProvider>
  )
}
