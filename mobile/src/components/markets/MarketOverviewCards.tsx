import React, {useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Svg, {Polyline} from 'react-native-svg';
import {
  formatMarketPercent,
  formatMarketPrice,
  type MarketInstrument,
} from '../../api/market';
import {colors, typography} from '../../theme';

type Props = {
  items: MarketInstrument[];
};

function TrendLine({positive, seed}: {positive: boolean; seed: string}) {
  const points = useMemo(() => {
    const base = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return Array.from({length: 7}, (_, index) => {
      const wave = (base + index * 17) % 19;
      const y = positive ? 29 - wave - index * 1.4 : 12 + wave + index * 1.2;
      return `${index * 12},${Math.max(6, Math.min(34, y))}`;
    }).join(' ');
  }, [positive, seed]);

  return (
    <Svg width="80" height="40" viewBox="0 0 72 40">
      <Polyline
        fill="none"
        points={points}
        stroke={positive ? colors.green : colors.red}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </Svg>
  );
}

export default function MarketOverviewCards({items}: Props) {
  return (
    <View style={styles.grid}>
      {items.slice(0, 6).map(item => {
        const positive = (item.changePercent || 0) >= 0;
        return (
          <View key={item.id} style={styles.card}>
            <Text style={styles.symbol}>{item.displaySymbol}</Text>
            <Text style={styles.price}>{formatMarketPrice(item)}</Text>
            <Text style={[styles.change, positive ? styles.up : styles.down]}>
              {formatMarketPercent(item.changePercent)}
            </Text>
            <View style={styles.trend}>
              <TrendLine positive={positive} seed={item.symbol} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  card: {
    width: '31.6%',
    minHeight: 114,
    borderRadius: 8,
    backgroundColor: colors.marketCard,
    borderWidth: 1,
    borderColor: colors.marketLine,
    paddingHorizontal: 11,
    paddingVertical: 11,
    overflow: 'hidden',
  },
  symbol: {
    ...typography.medium,
    color: colors.marketMuted,
    fontSize: 11,
  },
  price: {
    ...typography.number,
    marginTop: 10,
    color: colors.marketText,
    fontSize: 13,
    fontWeight: '800',
  },
  change: {
    ...typography.number,
    marginTop: 3,
    fontSize: 11,
    fontWeight: '800',
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  trend: {
    marginTop: 7,
    marginLeft: -3,
  },
});
