import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { formatAssetNumber } from '../../api/assets';
import type { AssetValuationRow } from '../../services/assetSnapshot';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import AssetEmptyState from './AssetEmptyState';
import { shouldUseCompactAssetLayout } from './assetLayout';

type Props = {
  items: AssetValuationRow[];
  hidden?: boolean;
  emptyTitle: string;
  title?: string;
};

function AssetCoinList({
  items,
  hidden = false,
  emptyTitle,
  title,
}: Props) {
  const { t } = useLanguage();
  const { width, fontScale } = useWindowDimensions();
  const compact = shouldUseCompactAssetLayout(width, fontScale);

  if (items.length === 0) {
    return <AssetEmptyState title={emptyTitle} />;
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.cardTitle}>{title ?? t('assets.coinDetails')}</Text>
          <Text style={styles.cardSubtitle}>{t('assets.realtimeSummary')}</Text>
        </View>
        <View style={styles.countChip}>
          <Text style={styles.countText}>
            {t('assets.countItems', { count: items.length })}
          </Text>
        </View>
      </View>
      {items.map(item => {
        return (
          <View key={item.key} style={styles.row}>
            <View
              style={[styles.rowTop, compact ? styles.rowTopCompact : null]}
            >
              <View style={styles.coinIdentity}>
                <View style={styles.coinBadge}>
                  <Text style={styles.coinBadgeText}>
                    {item.symbol.slice(0, 2)}
                  </Text>
                </View>
                <View>
                  <Text style={styles.symbol}>{item.symbol}</Text>
                  <Text style={styles.account}>
                    {t('assets.accountSuffix', {
                      account: accountLabel(item.accountKey, t),
                    })}
                  </Text>
                </View>
              </View>
              <View
                style={[
                  styles.valuation,
                  compact ? styles.valuationCompact : null,
                ]}
              >
                <Text style={styles.balanceLabel}>{t('assets.valuation')}</Text>
                <Text numberOfLines={2} style={styles.valuationValue}>
                  {hidden
                    ? '***'
                    : !item.valuationComplete || item.valueUsdt === null
                    ? '-- USDT'
                    : `${formatAssetNumber(item.valueUsdt, 2)} USDT`}
                </Text>
              </View>
            </View>
            <View
              style={[
                styles.balanceRow,
                compact ? styles.balanceRowCompact : null,
              ]}
            >
              <BalanceMetric
                label={t('assets.available')}
                value={hidden ? '***' : formatAssetNumber(item.available, 4)}
              />
              <View style={styles.balanceDivider} />
              <BalanceMetric
                label={t('assets.frozen')}
                value={hidden ? '***' : formatAssetNumber(item.frozen, 4)}
              />
              {!item.valuationComplete ? (
                <View
                  style={[
                    styles.warningChip,
                    compact ? styles.warningChipCompact : null,
                  ]}
                >
                  <Text style={styles.warning}>
                    {t('assets.valuationUnavailable')}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export default React.memo(AssetCoinList);

function BalanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.balanceMetric}>
      <Text style={styles.balanceLabel}>{label}</Text>
      <Text style={styles.balanceValue}>{value}</Text>
    </View>
  );
}

function accountLabel(value: string, t: ReturnType<typeof useLanguage>['t']) {
  const normalized = value.toLowerCase();
  if (normalized === 'funding') return t('assets.account.shortFunding');
  if (normalized === 'spot') return t('assets.account.shortSpot');
  if (normalized === 'contract') return t('assets.account.shortContract');
  return value;
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  header: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  cardSubtitle: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 9,
  },
  countChip: {
    borderRadius: 99,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  countText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 9,
  },
  row: {
    minHeight: 108,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: 12,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowTopCompact: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  coinIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  coinBadge: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    borderRadius: 12,
    backgroundColor: colors.goldSoft,
  },
  coinBadgeText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 10,
  },
  symbol: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  account: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 9,
  },
  valuation: {
    alignItems: 'flex-end',
  },
  valuationCompact: {
    alignItems: 'flex-start',
    marginTop: 10,
  },
  valuationValue: {
    ...typography.number,
    marginTop: 3,
    color: colors.text,
    fontSize: 12,
    fontWeight: '900',
  },
  balanceRow: {
    minHeight: 34,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  balanceRowCompact: {
    flexWrap: 'wrap',
    paddingVertical: 8,
  },
  balanceMetric: {
    minWidth: 72,
  },
  balanceLabel: {
    color: colors.textSubtle,
    fontSize: 9,
  },
  balanceValue: {
    ...typography.number,
    marginTop: 2,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
  },
  balanceDivider: {
    width: 1,
    height: 23,
    marginHorizontal: 14,
    backgroundColor: colors.line,
  },
  warningChip: {
    marginLeft: 'auto',
    borderRadius: 99,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  warningChipCompact: {
    marginTop: 8,
  },
  warning: {
    color: colors.gold,
    fontSize: 9,
  },
});
