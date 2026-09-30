import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Star } from 'lucide-react-native';
import {
  formatMarketPercent,
  formatMarketPrice,
  type MarketInstrument,
} from '../../api/market';
import { colors, typography } from '../../theme';
import MarketLogo from '../markets/MarketLogo';

type Props = {
  item: MarketInstrument;
  favorite?: boolean;
  favoriteDisabled?: boolean;
  favoriteAccessibilityLabel?: string;
  onPress?: (item: MarketInstrument) => void;
  onToggleFavorite?: (item: MarketInstrument) => void;
};

export default function MarketRow({
  item,
  favorite = false,
  favoriteDisabled = false,
  favoriteAccessibilityLabel,
  onPress,
  onToggleFavorite,
}: Props) {
  const isUp = item.changePercent !== null && item.changePercent >= 0;
  const isDown = item.changePercent !== null && item.changePercent < 0;
  const favoriteControl = onToggleFavorite ? (
    <Pressable
      accessibilityLabel={favoriteAccessibilityLabel}
      accessibilityState={{selected: favorite, disabled: favoriteDisabled}}
      disabled={favoriteDisabled}
      accessibilityRole="button"
      android_ripple={{
        color: 'rgba(212, 175, 55, 0.14)',
        borderless: true,
      }}
      onPress={event => {
        event.stopPropagation();
        onToggleFavorite(item);
      }}
      style={({ pressed }) => [
        styles.favoriteButton,
        pressed ? styles.pressed : null,
      ]}
    >
      <Star
        color={favorite ? colors.gold : colors.textSubtle}
        fill={favorite ? colors.gold : 'transparent'}
        size={18}
        strokeWidth={1.8}
      />
    </Pressable>
  ) : null;
  const content = (
    <>
      <View style={styles.identity}>
        <MarketLogo
          label={item.displaySymbol}
          logoUrl={item.logoUrl}
          positive={isUp || !isDown}
        />
        <View style={styles.nameWrap}>
          <Text numberOfLines={1} style={styles.name}>
            {item.displaySymbol}
          </Text>
          {item.name ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {item.name}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.right}>
        <Text style={styles.price}>{formatMarketPrice(item)}</Text>
        <View
          style={[
            styles.badge,
            isUp ? styles.up : null,
            isDown ? styles.down : null,
          ]}
        >
          <Text style={styles.badgeText}>
            {formatMarketPercent(item.changePercent)}
          </Text>
        </View>
      </View>
    </>
  );

  if (onPress) {
    return (
      <View style={styles.row}>
        {favoriteControl}
        <Pressable
          accessibilityLabel={`${item.displaySymbol}，${formatMarketPrice(item)}`}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          onPress={() => onPress(item)}
          style={({ pressed }) => [styles.rowContent, pressed ? styles.pressed : null]}
        >
          {content}
        </Pressable>
      </View>
    );
  }

  return <View style={styles.row}>{favoriteControl}{content}</View>;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.992 }] },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nameWrap: {
    flex: 1,
    minWidth: 0,
  },
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  favoriteButton: {
    width: 44,
    height: 44,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 15,
    flexShrink: 1,
  },
  subtitle: {
    marginTop: 4,
    color: colors.textSubtle,
    fontSize: 11,
  },
  right: {
    alignItems: 'flex-end',
  },
  price: {
    ...typography.marketPrice,
    marginBottom: 6,
    color: colors.text,
    fontSize: 14,
  },
  badge: {
    minWidth: 76,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    backgroundColor: colors.card,
  },
  up: {
    backgroundColor: colors.green,
  },
  down: {
    backgroundColor: colors.red,
  },
  badgeText: {
    ...typography.number,
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
});
