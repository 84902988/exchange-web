import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  ReceiptText,
  type LucideIcon,
} from 'lucide-react-native';
import {colors, typography} from '../../theme';

type Props = {
  onActionPress: (action: AssetQuickActionKey) => void;
};

export type AssetQuickActionKey = 'deposit' | 'withdraw' | 'transfer' | 'history';

const actions: Array<{key: AssetQuickActionKey; label: string; Icon: LucideIcon}> = [
  {key: 'deposit', label: '充值', Icon: ArrowDownToLine},
  {key: 'withdraw', label: '提现', Icon: ArrowUpFromLine},
  {key: 'transfer', label: '划转', Icon: ArrowRightLeft},
  {key: 'history', label: '资金流水', Icon: ReceiptText},
];

function AssetQuickActions({onActionPress}: Props) {
  return (
    <View style={styles.row}>
      {actions.map(({key, label, Icon}) => (
        <Pressable key={key} style={styles.action} onPress={() => onActionPress(key)}>
          <View style={styles.iconWrap}>
            <Icon color={colors.gold} size={18} strokeWidth={2.2} />
          </View>
          <Text style={styles.label}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default React.memo(AssetQuickActions);

const styles = StyleSheet.create({
  row: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  action: {
    flex: 1,
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: 'transparent',
  },
  iconWrap: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: 'rgba(214,168,50,0.12)',
  },
  label: {
    ...typography.bold,
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 11,
  },
});
