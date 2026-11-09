import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RunProvider } from '../state'
import { colors } from '../ui'

// Fade from the native splash (logo on #0B0B0F) into the first screen, which
// shares its background. The fade is iOS only; Android uses its own exit.
SplashScreen.setOptions({ duration: 500, fade: true })

export default function RootLayout () {
  return (
    <SafeAreaProvider>
      <RunProvider>
        <StatusBar style='light' />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen name='(tabs)' />
          <Stack.Screen name='onboarding' options={{ animation: 'fade', gestureEnabled: false }} />
        </Stack>
      </RunProvider>
    </SafeAreaProvider>
  )
}
