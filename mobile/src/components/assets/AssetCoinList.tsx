import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {
  estimateUsdtValue,
  formatAssetNumber,
  type AssetAccountBalance,
} from '../../api/assets';
import {colors, typography} from '../../theme';
import AssetEmptyState from './AssetEmptyState';

type Props = {
  items: AssetAccountBalance[];
  hidden?: boolean;
  emptyTitle: string;
};

function AssetCoinList({items, hidden = false, emptyTitle}: Props) {
  if (items.length === 0) {
    return <AssetEmptyState title={emptyTitle} />;
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={[styles.headerText, styles.symbolColumn]}>币种</Text>
        <Text style={styles.headerText}>可用</Text>
        <Text style={styles.headerText}>冻结</Text>
        <Text style={styles.headerText}>估值</Text>
      </View>
      {items.map(item => {
        const valuation = estimateUsdtValue(item);
        return (
          <View key={`${item.accountKey}-${item.symbol}`} style={styles.row}>
            <View style={styles.symbolColumn}>
              <Text style={styles.symbol}>{item.symbol}</Text>
              <Text style={styles.account}>{accountLabel(item.accountKey)}</Text>
            </View>
            <Text style={styles.value}>
              {hidden ? '***' : formatAssetNumber(item.available, 4)}
            </Text>
            <Text style={styles.value}>
              {hidden ? '***' : formatAssetNumber(item.frozen, 4)}
            </Text>
            <Text style={styles.value}>
              {hidden
                ? '***'
                : valuation === null
                  ? '-- USDT'
                  : `${formatAssetNumber(valuation, 2)} USDT`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default React.memo(AssetCoinList);

function accountLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'funding') return '资金';
  if (normalized === 'spot') return '现货';
  if (normalized === 'contract') return '合约';
  return value;
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  header: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerText: {
    flex: 1,
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'right',
  },
  symbolColumn: {
    flex: 1.1,
    textAlign: 'left',
  },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  symbol: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  account: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 10,
  },
  value: {
    ...typography.number,
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'right',
  },
});
