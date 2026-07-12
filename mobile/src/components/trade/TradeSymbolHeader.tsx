import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {BarChart3, ChevronDown, MoreHorizontal} from 'lucide-react-native';
import {formatSpotNumber, formatSpotPercent} from '../../api/spot';
import {colors, typography} from '../../theme';

type Props = {
  symbolLabel: string;
  lastPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
  onOpenChart: () => void;
  onOpenMore: () => void;
};

export default function TradeSymbolHeader({
  symbolLabel,
  lastPrice,
  changePercent,
  pricePrecision,
  onOpenChart,
  onOpenMore,
}: Props) {
  const up = (changePercent || 0) >= 0;

  return (
    <View style={styles.header}>
      <View style={styles.symbolBlock}>
        <View style={styles.symbolRow}>
          <Text style={styles.symbol}>{symbolLabel}</Text>
          <ChevronDown color={colors.textMuted} size={15} strokeWidth={2.2} />
        </View>
        <Text style={[styles.change, up ? styles.up : styles.down]}>
          {formatSpotPercent(changePercent)}
        </Text>
      </View>
      <Text style={styles.price}>
        {formatSpotNumber(lastPrice, pricePrecision)}
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="打开行情走势"
          accessibilityRole="button"
          style={styles.iconButton}
          onPress={onOpenChart}>
          <BarChart3 color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          accessibilityLabel="更多交易功能"
          accessibilityRole="button"
          style={styles.iconButton}
          onPress={onOpenMore}>
          <MoreHorizontal color={colors.text} size={20} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  symbolBlock: {
    flex: 1,
    minWidth: 0,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  symbol: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 16,
  },
  change: {
    ...typography.number,
    marginTop: 3,
    fontSize: 11,
    fontWeight: '600',
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  price: {
    ...typography.marketPrice,
    color: colors.text,
    fontSize: 15,
  },
  actions: {
    flexDirection: 'row',
    marginLeft: 8,
    gap: 6,
  },
  iconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.line,
  },
});
