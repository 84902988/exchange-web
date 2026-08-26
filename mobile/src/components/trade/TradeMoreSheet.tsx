import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  Crown,
  FileText,
  ReceiptText,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';
import { useLanguage, type TranslationKey } from '../../i18n';
import { colors, typography } from '../../theme';

type Action = {
  key: TradeMoreAction;
  labelKey: TranslationKey;
  Icon: LucideIcon;
};

export type TradeMoreAction =
  | 'deposit'
  | 'withdraw'
  | 'transfer'
  | 'fundHistory'
  | 'assets'
  | 'orders'
  | 'rcbFee';

type Props = {
  visible: boolean;
  onClose: () => void;
  onActionPress: (action: TradeMoreAction) => void;
};

const actions: Action[] = [
  { key: 'deposit', labelKey: 'assets.quick.deposit', Icon: ArrowDownToLine },
  { key: 'withdraw', labelKey: 'assets.quick.withdraw', Icon: ArrowUpFromLine },
  { key: 'transfer', labelKey: 'assets.quick.transfer', Icon: ArrowRightLeft },
  { key: 'fundHistory', labelKey: 'assets.quick.history', Icon: ReceiptText },
  { key: 'assets', labelKey: 'nav.assets', Icon: Wallet },
  { key: 'orders', labelKey: 'trading.orders', Icon: FileText },
  { key: 'rcbFee', labelKey: 'trading.rcbFeeSettings', Icon: Crown },
];

function TradeMoreSheet({ visible, onClose, onActionPress }: Props) {
  const { t } = useLanguage();
  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>{t('trading.moreTitle')}</Text>
          <View style={styles.grid}>
            {actions.map(({ key, labelKey, Icon }) => (
              <Pressable
                accessibilityLabel={t(labelKey)}
                accessibilityRole="button"
                android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                key={key}
                style={({ pressed }) => [
                  styles.item,
                  pressed ? styles.pressed : null,
                ]}
                onPress={() => onActionPress(key)}
              >
                <View style={styles.iconWrap}>
                  <Icon color={colors.gold} size={18} strokeWidth={2.2} />
                </View>
                <Text style={styles.label}>{t(labelKey)}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default React.memo(TradeMoreSheet);

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 26,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginBottom: 12,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 16,
  },
  grid: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  item: {
    width: '30.8%',
    minHeight: 76,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
  },
  iconWrap: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.primarySoft,
  },
  label: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 11,
  },
});
