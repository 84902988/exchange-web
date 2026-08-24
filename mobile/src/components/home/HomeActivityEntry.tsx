import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ArrowRight, Gift } from 'lucide-react-native';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

export default function HomeActivityEntry({
  onPress,
}: {
  onPress: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('home.activityCenterA11y')}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.icon}>
        <Gift color={colors.gold} size={21} strokeWidth={2.1} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{t('home.activityCenter')}</Text>
        <Text style={styles.subtitle}>
          {t('home.activityCenterDescription')}
        </Text>
      </View>
      <ArrowRight color={colors.textMuted} size={18} strokeWidth={2.1} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  card: {
    minHeight: 68,
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.3)',
    backgroundColor: 'rgba(214,168,50,0.08)',
    paddingHorizontal: 14,
  },
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
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
