import { Redirect, Tabs } from 'expo-router'
import { Text } from 'react-native'
import { hasOnboarded } from '../../onboarding'
import { colors } from '../../ui'

function icon (glyph: string) {
  function TabIcon ({ color }: { color: string }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>
  }
  return TabIcon
}

export default function TabsLayout () {
  // First launch: show the guide before the tabs.
  if (!hasOnboarded()) return <Redirect href='/onboarding' />
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.dim,
        sceneStyle: { backgroundColor: colors.bg }
      }}
    >
      <Tabs.Screen name='index' options={{ title: 'Data', tabBarIcon: icon('▤') }} />
      <Tabs.Screen name='train' options={{ title: 'Train', tabBarIcon: icon('◎') }} />
      <Tabs.Screen name='try' options={{ title: 'Try', tabBarIcon: icon('✦') }} />
    </Tabs>
  )
}
