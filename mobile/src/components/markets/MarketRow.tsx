import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  formatMarketPercent,
  formatMarketPrice,
  type MarketInstrument,
} from '../../api/market';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';
import MarketLogo from './MarketLogo';

type Props = {
  item: MarketInstrument;
  onPress?: (item: MarketInstrument) => void;
};

export default function MarketRow({item, onPress}: Props) {
  const {t} = useLanguage();
  const positive = (item.changePercent || 0) >= 0;

  const content = (
    <>
      <View style={styles.left}>
        <MarketLogo
          label={item.displaySymbol}
          logoUrl={item.logoUrl}
          positive={positive}
        />
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
    </>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={`${item.displaySymbol}${t(
          'common.a11ySeparator',
        )}${formatMarketPrice(item)}`}
        accessibilityRole="button"
        android_ripple={{color: 'rgba(214,168,50,0.10)'}}
        onPress={() => onPress(item)}
        style={({pressed}) => [styles.row, pressed ? styles.pressed : null]}>
        {content}
      </Pressable>
    );
  }

  return <View style={styles.row}>{content}</View>;
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
  pressed: {
    opacity: 0.78,
    backgroundColor: 'rgba(214,168,50,0.06)',
  },
});
