import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  formatMarketPercent,
  formatMarketPrice,
  type MarketInstrument,
} from '../../api/market';
import { colors, typography } from '../../theme';

type Props = {
  items: MarketInstrument[];
  onPress: (item: MarketInstrument) => void;
};

export default function MarketOverviewCards({ items, onPress }: Props) {
  return (
    <View style={styles.grid}>
      {items.slice(0, 6).map(item => {
        const positive = (item.changePercent || 0) >= 0;
        return (
          <Pressable
            accessibilityLabel={item.displaySymbol}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            key={item.id}
            onPress={() => onPress(item)}
            style={({ pressed }) => [
              styles.card,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.symbol}>{item.displaySymbol}</Text>
            <Text style={styles.price}>{formatMarketPrice(item)}</Text>
            <Text style={[styles.change, positive ? styles.up : styles.down]}>
              {formatMarketPercent(item.changePercent)}
            </Text>
          </Pressable>
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
    minHeight: 82,
    borderRadius: 8,
    backgroundColor: colors.marketCard,
    borderWidth: 1,
    borderColor: colors.marketLine,
    paddingHorizontal: 11,
    paddingVertical: 11,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.76,
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
});
