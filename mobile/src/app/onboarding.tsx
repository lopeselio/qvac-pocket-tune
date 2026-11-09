import { useEffect, useRef, useState } from 'react'
import { Animated, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { router } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { markOnboarded } from '../onboarding'
import { Button, colors } from '../ui'

interface Point { glyph: string, title: string, text: string }
interface Page { key: string, title: string, lead: string, points?: Point[] }

const PAGES: Page[] = [
  {
    key: 'welcome',
    title: 'Pocket Tune',
    lead: 'Teach a small AI to talk like you, from your own chats and notes. It all happens on this phone.'
  },
  {
    key: 'private',
    title: 'Private by design',
    lead: 'Pocket Tune runs the model with QVAC, right on your phone.',
    points: [
      { glyph: '◉', title: 'No cloud, no account', text: 'Your files, the training and every answer stay on this device.' },
      { glyph: '✂', title: 'Scrubbed before training', text: 'Emails, phone numbers, keys and addresses are removed first. You can turn this off.' },
      { glyph: '⌫', title: 'Yours to delete', text: 'Deleting the app deletes everything it learned.' }
    ]
  },
  {
    key: 'how',
    title: 'Three steps',
    lead: 'The tabs at the bottom follow the same order.',
    points: [
      { glyph: '▤', title: 'Data', text: 'Pick a WhatsApp chat export, a Q&A CSV or notes. No data handy? Tap Use sample.' },
      { glyph: '◎', title: 'Train', text: 'Your phone trains a small add-on (a LoRA adapter) on top of the model. You can pause and resume.' },
      { glyph: '✦', title: 'Try', text: 'Ask the original model and your tuned one the same question and compare the answers.' }
    ]
  },
  {
    key: 'tips',
    title: 'For a smooth first run',
    lead: 'Training is real work for a phone.',
    points: [
      { glyph: '⚡', title: 'Plug in and stay on Wi-Fi', text: 'The first run downloads the model (about 380 MB) and training draws power.' },
      { glyph: '◔', title: 'Start small', text: 'The default 0.6B model with 20–60 examples finishes in minutes.' },
      { glyph: '❄', title: 'Keep it cool', text: 'Take off the case. A hot phone slows itself down.' }
    ]
  }
]

export default function Onboarding () {
  const { width } = useWindowDimensions()
  const scroller = useRef<ScrollView>(null)
  const [page, setPage] = useState(0)
  const last = page === PAGES.length - 1

  function finish () {
    markOnboarded()
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }

  function go (i: number) {
    scroller.current?.scrollTo({ x: i * width, animated: true })
    setPage(i)
  }

  function onScroll (e: NativeSyntheticEvent<NativeScrollEvent>) {
    const i = Math.round(e.nativeEvent.contentOffset.x / width)
    if (i !== page) setPage(Math.max(0, Math.min(PAGES.length - 1, i)))
  }

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.top}>
        {!last && (
          <Pressable onPress={finish} hitSlop={12} accessibilityRole='button'>
            <Text style={s.skip}>Skip</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={{ flex: 1 }}
      >
        {PAGES.map((p, i) => (
          <View key={p.key} style={[s.page, { width }]} accessibilityElementsHidden={i !== page} importantForAccessibility={i === page ? 'auto' : 'no-hide-descendants'}>
            {p.key === 'welcome' ? <Welcome page={p} /> : <Points page={p} />}
          </View>
        ))}
      </ScrollView>

      <View style={s.footer}>
        <View style={s.dots} accessibilityRole='adjustable' accessibilityLabel={`Page ${page + 1} of ${PAGES.length}`}>
          {PAGES.map((p, i) => <View key={p.key} style={[s.dot, i === page && s.dotOn]} />)}
        </View>
        <Button title={last ? 'Get started' : 'Next'} onPress={() => (last ? finish() : go(page + 1))} />
      </View>
    </SafeAreaView>
  )
}

function Welcome ({ page }: { page: Page }) {
  const appear = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.spring(appear, { toValue: 1, useNativeDriver: true, friction: 7, tension: 40 }).start()
  }, [appear])
  const scale = appear.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] })
  return (
    <View style={s.welcome}>
      <Animated.View style={{ opacity: appear, transform: [{ scale }] }}>
        <Image source={require('../../assets/icon.png')} style={s.logo} accessibilityIgnoresInvertColors accessible={false} />
      </Animated.View>
      <Text style={s.brand} accessibilityRole='header'>{page.title}</Text>
      <Text style={s.lead}>{page.lead}</Text>
    </View>
  )
}

function Points ({ page }: { page: Page }) {
  return (
    <View style={s.points}>
      <Text style={s.title} accessibilityRole='header'>{page.title}</Text>
      <Text style={s.lead}>{page.lead}</Text>
      <View style={{ gap: 14, marginTop: 8 }}>
        {page.points?.map((pt) => (
          <View key={pt.title} style={s.point}>
            <View style={s.badge}><Text style={s.badgeText}>{pt.glyph}</Text></View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={s.pointTitle}>{pt.title}</Text>
              <Text style={s.pointText}>{pt.text}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  top: { height: 44, paddingHorizontal: 20, alignItems: 'flex-end', justifyContent: 'center' },
  skip: { color: colors.dim, fontSize: 16, fontWeight: '600' },
  page: { flex: 1, paddingHorizontal: 24 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingBottom: 40 },
  logo: { width: 132, height: 132, borderRadius: 30, marginBottom: 10 },
  brand: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  points: { flex: 1, justifyContent: 'center', gap: 8, paddingBottom: 20 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.3 },
  lead: { color: colors.dim, fontSize: 17, lineHeight: 24, textAlign: 'left', maxWidth: 420 },
  point: { flexDirection: 'row', gap: 14, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14 },
  badge: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#0F2A1A', alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: colors.accent, fontSize: 18 },
  pointTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pointText: { color: colors.dim, fontSize: 14, lineHeight: 20 },
  footer: { paddingHorizontal: 24, paddingBottom: 12, gap: 18 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotOn: { width: 22, backgroundColor: colors.accent }
})
