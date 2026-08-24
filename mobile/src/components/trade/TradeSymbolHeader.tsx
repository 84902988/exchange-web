import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BarChart3, ChevronDown, MoreHorizontal } from 'lucide-react-native';
import { formatSpotPercent } from '../../api/spot';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import { formatFixedPrice } from '../../utils/format';
import MarketLogo from '../markets/MarketLogo';

type Props = {
  baseAsset: string;
  logoUrl?: string | null;
  symbolLabel: string;
  lastPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
  onSymbolPress: () => void;
  onOpenChart: () => void;
  onOpenMore: () => void;
};

function TradeSymbolHeader({
  baseAsset,
  logoUrl,
  symbolLabel,
  lastPrice,
  changePercent,
  pricePrecision,
  onSymbolPress,
  onOpenChart,
  onOpenMore,
}: Props) {
  const { t } = useLanguage();
  const up = (changePercent || 0) >= 0;

  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel={t('trading.selectSpotSymbolA11y')}
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
          size={30}
        />
        <View style={styles.symbolTextBlock}>
          <View style={styles.symbolRow}>
            <Text style={styles.symbol}>{symbolLabel}</Text>
            <ChevronDown color={colors.textMuted} size={15} strokeWidth={2.2} />
          </View>
          <Text style={[styles.change, up ? styles.up : styles.down]}>
            {formatSpotPercent(changePercent)}
          </Text>
        </View>
      </Pressable>
      <Text style={styles.price}>
        {formatFixedPrice(lastPrice, pricePrecision)}
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={t('trading.openMarketChartA11y')}
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
          <BarChart3 color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          accessibilityLabel={t('trading.moreFunctionsA11y')}
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
          <MoreHorizontal color={colors.text} size={20} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  );
}

export default React.memo(TradeSymbolHeader);

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  symbolBlock: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  symbolTextBlock: {
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
    fontSize: 17,
  },
  change: {
    ...typography.number,
    marginTop: 3,
    fontSize: 12,
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
    fontSize: 18,
  },
  actions: {
    flexDirection: 'row',
    marginLeft: 10,
    gap: 8,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.line,
  },
});
