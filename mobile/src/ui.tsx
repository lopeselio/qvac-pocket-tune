import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export const colors = {
  bg: '#0B0B0F',
  card: '#15151C',
  border: '#262633',
  text: '#F2F2F7',
  dim: '#9A9AAD',
  accent: '#22C55E',
  warn: '#F59E0B',
  danger: '#EF4444'
}

export function Screen ({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps='handled'>{children}</ScrollView>
    </SafeAreaView>
  )
}

export function Card ({ title, children }: { title?: string, children: ReactNode }) {
  return (
    <View style={s.card}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  )
}

export function H1 ({ children }: { children: ReactNode }) {
  return <Text style={s.h1}>{children}</Text>
}

export function P ({ children, dim, color }: { children: ReactNode, dim?: boolean, color?: string }) {
  return <Text style={[s.p, dim && { color: colors.dim }, color ? { color } : null]}>{children}</Text>
}

export function Button ({ title, onPress, disabled, kind = 'primary', busy }: { title: string, onPress: () => void, disabled?: boolean, kind?: 'primary' | 'secondary' | 'danger', busy?: boolean }) {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.danger : colors.border
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={kind === 'primary' ? '#000' : colors.text} /> : <Text style={[s.btnText, kind === 'primary' && { color: '#04130A' }]}>{title}</Text>}
    </Pressable>
  )
}

export function Field ({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.dim} style={[s.input, props.multiline && { minHeight: 72, textAlignVertical: 'top' }]} {...props} />
    </View>
  )
}

export function Chips<T extends string> ({ options, value, onChange }: { options: { key: T, label: string }[], value: T, onChange: (v: T) => void }) {
  return (
    <View style={s.chips}>
      {options.map((o) => (
        <Pressable key={o.key} onPress={() => onChange(o.key)} accessibilityRole='radio' accessibilityState={{ selected: value === o.key }}
          style={[s.chip, value === o.key && { borderColor: colors.accent, backgroundColor: '#0F2A1A' }]}>
          <Text style={[s.chipText, value === o.key && { color: colors.accent }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

export function Progress ({ value }: { value: number }) {
  return (
    <View style={s.bar} accessibilityRole='progressbar' accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <View style={[s.fill, { width: `${Math.max(0, Math.min(1, value)) * 100}%` }]} />
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  h1: { color: colors.text, fontSize: 24, fontWeight: '700' },
  p: { color: colors.text, fontSize: 15, lineHeight: 21 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.dim, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  btn: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  label: { color: colors.dim, fontSize: 13 },
  input: { backgroundColor: colors.bg, color: colors.text, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  chipText: { color: colors.text, fontSize: 14 },
  bar: { height: 10, backgroundColor: colors.bg, borderRadius: 5, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  fill: { height: '100%', backgroundColor: colors.accent }
})
