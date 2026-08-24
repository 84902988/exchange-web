import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ArrowRight, Landmark } from 'lucide-react-native';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

export default function HomeAboutEntry({ onPress }: { onPress: () => void }) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('home.aboutA11y')}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.icon}>
        <Landmark color={colors.gold} size={20} strokeWidth={2.1} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{t('home.about')}</Text>
        <Text style={styles.subtitle}>{t('home.aboutDescription')}</Text>
      </View>
      <ArrowRight color={colors.textMuted} size={18} strokeWidth={2.1} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  card: {
    minHeight: 64,
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
  },
  icon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.goldSoft,
  },
  copy: { flex: 1, marginHorizontal: 12 },
  title: { ...typography.bold, color: colors.text, fontSize: 14 },
  subtitle: {
    ...typography.regular,
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 11,
  },
});
