import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  formatMarketPercent,
  formatMarketPrice,
  type MarketInstrument,
} from '../../api/market';
import {colors, typography} from '../../theme';

type Props = {
  item: MarketInstrument;
  onPress?: (item: MarketInstrument) => void;
};

export default function MarketRow({item, onPress}: Props) {
  const positive = (item.changePercent || 0) >= 0;
  const avatarText = item.displaySymbol.slice(0, 2).toUpperCase();

  return (
    <Pressable style={styles.row} onPress={() => onPress?.(item)}>
      <View style={styles.left}>
        <View style={[styles.avatar, positive ? styles.avatarUp : styles.avatarDown]}>
          <Text style={styles.avatarText}>{avatarText}</Text>
        </View>
        <View style={styles.nameWrap}>
          <Text numberOfLines={1} style={styles.symbol}>
            {item.displaySymbol}
          </Text>
          <Text numberOfLines={1} style={styles.name}>
            {item.name}
          </Text>
        </View>
      </View>

      <Text style={styles.price}>{formatMarketPrice(item)}</Text>

      <View style={[styles.badge, positive ? styles.upBadge : styles.downBadge]}>
        <Text style={styles.badgeText}>{formatMarketPercent(item.changePercent)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.marketLine,
  },
  left: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarUp: {
    backgroundColor: 'rgba(25, 195, 125, 0.14)',
  },
  avatarDown: {
    backgroundColor: 'rgba(240, 90, 90, 0.14)',
  },
  avatarText: {
    ...typography.semibold,
    color: colors.marketText,
    fontSize: 10,
  },
  nameWrap: {
    flex: 1,
    minWidth: 0,
  },
  symbol: {
    ...typography.semibold,
    color: colors.marketText,
    fontSize: 13,
  },
  name: {
    marginTop: 3,
    color: colors.marketSubtle,
    fontSize: 10,
  },
  price: {
    ...typography.marketPrice,
    width: 94,
    textAlign: 'right',
    color: colors.marketText,
    fontSize: 13,
  },
  badge: {
    width: 76,
    height: 29,
    marginLeft: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  upBadge: {
    backgroundColor: colors.green,
  },
  downBadge: {
    backgroundColor: '#FF3B79',
  },
  badgeText: {
    ...typography.number,
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
});
