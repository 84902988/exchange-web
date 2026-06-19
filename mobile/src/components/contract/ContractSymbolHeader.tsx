import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {BarChart3, ChevronDown, MoreHorizontal} from 'lucide-react-native';
import {formatContractNumber, formatContractPercent} from '../../api/contract';
import {colors, typography} from '../../theme';

type Props = {
  symbolLabel: string;
  lastPrice: number | null;
  markPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
  marketStatus?: string | null;
  fundingRateText?: string;
  onOpenChart: () => void;
  onOpenMore: () => void;
};

function ContractSymbolHeader({
  symbolLabel,
  lastPrice,
  markPrice,
  changePercent,
  pricePrecision,
  marketStatus,
  fundingRateText = '资金费率 --',
  onOpenChart,
  onOpenMore,
}: Props) {
  const up = (changePercent || 0) >= 0;
  const statusText = marketStatus || '合约行情';

  return (
    <View style={styles.header}>
      <View style={styles.symbolBlock}>
        <View style={styles.symbolRow}>
          <Text style={styles.symbol}>{symbolLabel}</Text>
          <ChevronDown color={colors.textMuted} size={14} strokeWidth={2.2} />
        </View>
        <View style={styles.metaRow}>
          <Text style={[styles.change, up ? styles.up : styles.down]}>
            {formatContractPercent(changePercent)}
          </Text>
          <Text style={styles.metaText}>永续</Text>
          <Text style={styles.metaText}>{statusText}</Text>
          <Text style={styles.metaText}>{fundingRateText}</Text>
        </View>
      </View>
      <View style={styles.priceBlock}>
        <Text style={[styles.price, up ? styles.up : styles.down]}>
          {formatContractNumber(lastPrice, pricePrecision)}
        </Text>
        <Text style={styles.markPrice}>
          标记 {formatContractNumber(markPrice, pricePrecision)}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="打开合约K线"
          accessibilityRole="button"
          style={styles.iconButton}
          onPress={onOpenChart}>
          <BarChart3 color={colors.text} size={16} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          accessibilityLabel="更多合约功能"
          accessibilityRole="button"
          style={styles.iconButton}
          onPress={onOpenMore}>
          <MoreHorizontal color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  );
}

export default React.memo(ContractSymbolHeader);

const styles = StyleSheet.create({
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: 6,
  },
  symbolBlock: {
    flex: 1,
    minWidth: 0,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  symbol: {
    ...typography.heavy,
    color: colors.text,
    fontSize: 15,
  },
  metaRow: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
  },
  metaText: {
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  change: {
    ...typography.number,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 12,
  },
  priceBlock: {
    alignItems: 'flex-end',
    marginLeft: 6,
  },
  price: {
    ...typography.number,
    fontSize: 15,
    fontWeight: '900',
  },
  markPrice: {
    ...typography.number,
    marginTop: 1,
    color: colors.textMuted,
    fontSize: 9,
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  actions: {
    flexDirection: 'row',
    marginLeft: 6,
    gap: 4,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
});
