import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  ReceiptText,
  type LucideIcon,
} from 'lucide-react-native';
import { useLanguage, type TranslationKey } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = {
  onActionPress: (action: AssetQuickActionKey) => void;
};

export type AssetQuickActionKey =
  | 'deposit'
  | 'withdraw'
  | 'transfer'
  | 'history';

const actions: Array<{
  key: AssetQuickActionKey;
  labelKey: TranslationKey;
  Icon: LucideIcon;
}> = [
  { key: 'deposit', labelKey: 'assets.quick.deposit', Icon: ArrowDownToLine },
  { key: 'withdraw', labelKey: 'assets.quick.withdraw', Icon: ArrowUpFromLine },
  { key: 'transfer', labelKey: 'assets.quick.transfer', Icon: ArrowRightLeft },
  { key: 'history', labelKey: 'assets.quick.history', Icon: ReceiptText },
];

function AssetQuickActions({ onActionPress }: Props) {
  const { t } = useLanguage();
  return (
    <View style={styles.row}>
      {actions.map(({ key, labelKey, Icon }) => {
        const label = t(labelKey);
        return (
          <Pressable
            key={key}
            accessibilityLabel={label}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            style={({ pressed }) => [
              styles.action,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onActionPress(key)}
          >
            <View style={styles.iconWrap}>
              <Icon color={colors.gold} size={18} strokeWidth={2.2} />
            </View>
            <Text
              maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              style={styles.label}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default React.memo(AssetQuickActions);

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  row: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  action: {
    flex: 1,
    minHeight: 74,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  iconWrap: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: 'rgba(214,168,50,0.12)',
  },
  label: {
    ...typography.bold,
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 10,
  },
});
