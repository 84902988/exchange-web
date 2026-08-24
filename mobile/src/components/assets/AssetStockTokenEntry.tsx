import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, LockKeyhole } from 'lucide-react-native';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

function AssetStockTokenEntry({ onPress }: { onPress: () => void }) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('assets.stockTokenA11y')}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
      onPress={onPress}
    >
      <View style={styles.iconWrap}>
        <LockKeyhole color={colors.gold} size={19} strokeWidth={2.2} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{t('assets.stockTokenTitle')}</Text>
        <Text style={styles.subtitle}>{t('assets.stockTokenSubtitle')}</Text>
      </View>
      <ChevronRight color={colors.textSubtle} size={18} strokeWidth={2.2} />
    </Pressable>
  );
}

export default React.memo(AssetStockTokenEntry);

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  card: {
    minHeight: 68,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: 'rgba(214,168,50,0.12)',
  },
  copy: { flex: 1, marginHorizontal: 11 },
  title: { ...typography.bold, color: colors.text, fontSize: 13 },
  subtitle: { marginTop: 4, color: colors.textMuted, fontSize: 10 },
});
