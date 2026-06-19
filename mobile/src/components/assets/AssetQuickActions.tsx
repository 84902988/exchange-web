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
  onActionPress: (label: string) => void;
};

const actions: Array<{label: string; Icon: LucideIcon}> = [
  {label: '充值', Icon: ArrowDownToLine},
  {label: '提现', Icon: ArrowUpFromLine},
  {label: '划转', Icon: ArrowRightLeft},
  {label: '资金流水', Icon: ReceiptText},
];

function AssetQuickActions({onActionPress}: Props) {
  return (
    <View style={styles.row}>
      {actions.map(({label, Icon}) => (
        <Pressable key={label} style={styles.action} onPress={() => onActionPress(label)}>
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
