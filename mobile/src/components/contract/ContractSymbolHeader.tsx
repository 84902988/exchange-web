import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BarChart3, ChevronDown, MoreHorizontal } from 'lucide-react-native';
import {
  formatContractPercent,
} from '../../api/contract';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import { formatFixedPrice } from '../../utils/format';
import MarketLogo from '../markets/MarketLogo';

type Props = {
  baseAsset: string;
  logoUrl?: string | null;
  symbolLabel: string;
  lastPrice: number | null;
  markPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
  marketStatus?: string | null;
  onSymbolPress: () => void;
  onOpenChart: () => void;
  onOpenMore: () => void;
};

function ContractSymbolHeader({
  baseAsset,
  logoUrl,
  symbolLabel,
  lastPrice,
  markPrice,
  changePercent,
  pricePrecision,
  marketStatus,
  onSymbolPress,
  onOpenChart,
  onOpenMore,
}: Props) {
  const { t } = useLanguage();
  const up = (changePercent || 0) >= 0;
  const statusText = marketStatus || t('trading.contractMarket');

  return (
    <View testID="contract-symbol-header" style={styles.header}>
      <Pressable
        accessibilityLabel={t('trading.selectContractSymbolA11y')}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
        style={({ pressed }) => [
          styles.symbolBlock,
          pressed ? styles.pressed : null,
        ]}
        onPress={onSymbolPress}
      >
        <MarketLogo
          label={baseAsset}
          logoUrl={logoUrl}
          positive={up}
          size={28}
        />
        <View style={styles.symbolTextBlock}>
          <View style={styles.symbolRow}>
            <Text ellipsizeMode="tail" numberOfLines={1} style={styles.symbol}>
              {symbolLabel}
            </Text>
            <ChevronDown color={colors.textMuted} size={14} strokeWidth={2.2} />
          </View>
          <View testID="contract-symbol-meta-row" style={styles.metaRow}>
            <Text
              ellipsizeMode="tail"
              numberOfLines={1}
              style={[styles.change, up ? styles.up : styles.down]}
            >
              {formatContractPercent(changePercent)}
            </Text>
            <Text numberOfLines={1} style={styles.metaTextFixed}>
              {t('trading.perpetual')}
            </Text>
            <Text
              ellipsizeMode="tail"
              numberOfLines={1}
              style={styles.metaText}
            >
              {statusText}
            </Text>
          </View>
        </View>
      </Pressable>
      <View style={styles.priceBlock}>
        <Text style={[styles.price, up ? styles.up : styles.down]}>
          {formatFixedPrice(lastPrice, pricePrecision)}
        </Text>
        <Text style={styles.markPrice}>
          {t('trading.markPriceShort', {
            price: formatFixedPrice(markPrice, pricePrecision),
          })}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={t('trading.openContractChartA11y')}
          accessibilityRole="button"
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          style={({ pressed }) => [
            styles.iconButton,
            pressed ? styles.pressed : null,
          ]}
          onPress={onOpenChart}
        >
          <BarChart3 color={colors.text} size={16} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          accessibilityLabel={t('trading.moreContractFunctionsA11y')}
          accessibilityRole="button"
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          style={({ pressed }) => [
            styles.iconButton,
            pressed ? styles.pressed : null,
          ]}
          onPress={onOpenMore}
        >
          <MoreHorizontal color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  );
}

export default React.memo(ContractSymbolHeader);

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: 6,
  },
  symbolBlock: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  symbolTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    overflow: 'hidden',
  },
  symbol: {
    ...typography.semibold,
    flexShrink: 1,
    color: colors.text,
    fontSize: 15,
  },
  metaRow: {
    marginTop: 3,
    height: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'nowrap',
    overflow: 'hidden',
  },
  metaText: {
    flexShrink: 1,
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  metaTextFixed: {
    flexShrink: 0,
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  change: {
    ...typography.number,
    flexShrink: 0,
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 12,
  },
  priceBlock: {
    alignItems: 'flex-end',
    marginLeft: 6,
  },
  price: {
    ...typography.marketPrice,
    fontSize: 15,
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
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
});
