import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLanguage, type TranslationKey } from '../../i18n';
import { colors, typography } from '../../theme';

export type AssetTabKey = 'overview' | 'spot' | 'contract' | 'invite' | 'bd';

type Props = {
  activeKey: AssetTabKey;
  onChange: (key: AssetTabKey) => void;
};

const tabs: Array<{ key: AssetTabKey; labelKey: TranslationKey }> = [
  { key: 'overview', labelKey: 'assets.tab.overview' },
  { key: 'spot', labelKey: 'assets.tab.spot' },
  { key: 'contract', labelKey: 'assets.tab.contract' },
  { key: 'invite', labelKey: 'assets.tab.invite' },
  { key: 'bd', labelKey: 'assets.tab.bd' },
];

function AssetTopTabs({ activeKey, onChange }: Props) {
  const { t } = useLanguage();
  return (
    <View accessibilityRole="tablist" style={styles.content}>
      {tabs.map(tab => {
        const active = tab.key === activeKey;
        const label = t(tab.labelKey);
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityLabel={t('assets.tabA11y', { label })}
            accessibilityState={{ selected: active }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            style={({ pressed }) => [
              styles.tab,
              active ? styles.activeTab : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onChange(tab.key)}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              style={[styles.label, active ? styles.activeLabel : null]}
            >
              {label}
            </Text>
            <View
              style={[styles.indicator, active ? styles.activeIndicator : null]}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

export default React.memo(AssetTopTabs);

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  content: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 4,
  },
  tab: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  label: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  activeLabel: {
    color: colors.gold,
    fontWeight: '900',
  },
  activeTab: {
    backgroundColor: 'rgba(214,168,50,0.1)',
  },
  indicator: {
    position: 'absolute',
    bottom: 4,
    width: 16,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'transparent',
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
});
