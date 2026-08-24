import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  formatMarketPercent,
  formatMarketPrice,
  type MarketInstrument,
} from '../../api/market';
import {colors, typography} from '../../theme';
import {useLanguage, type TranslationKey} from '../../i18n';
import MarketLogo from '../markets/MarketLogo';

type Props = {
  items?: readonly MarketInstrument[];
  onPress?: (item: MarketInstrument) => void;
};

const categoryLabelKeys: Record<
  MarketInstrument['category'],
  TranslationKey
> = {
  crypto: 'market.crypto',
  stock: 'market.stock',
  cfd: 'market.cfd',
  onchain: 'market.onchain',
};

export default function MarketShortcutGrid({
  items = [],
  onPress,
}: Props) {
  const visibleItems = items.slice(0, 4);
  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <View style={styles.grid}>
      {Array.from(
        {length: Math.ceil(visibleItems.length / 2)},
        (_, rowIndex) => visibleItems.slice(rowIndex * 2, rowIndex * 2 + 2),
      ).map(row => (
        <View key={row[0].id} style={styles.gridRow}>
          {row.map(item => (
            <ShortcutCard item={item} key={item.id} onPress={onPress} />
          ))}
          {row.length === 1 ? <View style={styles.cardSpacer} /> : null}
        </View>
      ))}
    </View>
  );
}

function ShortcutCard({
  item,
  onPress,
}: {
  item: MarketInstrument;
  onPress?: Props['onPress'];
}) {
  const {t} = useLanguage();
  const isUp = item.changePercent !== null && item.changePercent >= 0;
  const isDown = item.changePercent !== null && item.changePercent < 0;
  const content = (
    <>
      <View style={styles.titleRow}>
        <MarketLogo
          label={item.displaySymbol}
          logoUrl={item.logoUrl}
          positive={isUp || !isDown}
          size={24}
        />
        <Text style={styles.title}>{t(categoryLabelKeys[item.category])}</Text>
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {item.displaySymbol}
      </Text>
      <View style={styles.row}>
        <Text style={styles.price}>{formatMarketPrice(item)}</Text>
        <Text
          style={[
            styles.change,
            isUp ? styles.up : null,
            isDown ? styles.down : null,
          ]}>
          {formatMarketPercent(item.changePercent)}
        </Text>
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
        android_ripple={{color: 'rgba(214,168,50,0.12)'}}
        onPress={() => onPress(item)}
        style={({pressed}) => [styles.card, pressed ? styles.pressed : null]}>
        {content}
      </Pressable>
    );
  }

  return <View style={styles.card}>{content}</View>;
}

const styles = StyleSheet.create({
  grid: {
    gap: 10,
  },
  gridRow: {
    flexDirection: 'row',
    gap: 10,
  },
  card: {
    flex: 1,
    minWidth: 0,
    minHeight: 96,
    padding: 13,
    borderRadius: 8,
    backgroundColor: '#15171D',
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.12)',
  },
  cardSpacer: {
    flex: 1,
  },
  title: {
    color: colors.textSubtle,
    fontSize: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    marginTop: 7,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  row: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  price: {
    ...typography.number,
    flexShrink: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  change: {
    ...typography.number,
    color: colors.textSubtle,
    fontSize: 12,
    fontWeight: '800',
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  pressed: {
    opacity: 0.84,
    transform: [{scale: 0.985}],
  },
});
