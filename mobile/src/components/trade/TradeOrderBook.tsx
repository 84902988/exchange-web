import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  formatSpotNumber,
  type SpotOrderBookLevel,
  type SpotTrade,
} from '../../api/spot';
import {colors, typography} from '../../theme';

type Props = {
  asks: SpotOrderBookLevel[];
  bids: SpotOrderBookLevel[];
  trades: SpotTrade[];
  lastPrice: number | null;
  pricePrecision: number;
  onPricePress: (price: string) => void;
};

function TradeOrderBook({
  asks,
  bids,
  trades,
  lastPrice,
  pricePrecision,
  onPricePress,
}: Props) {
  const latestTrade = trades[0];
  const priceUp = latestTrade?.side !== 'SELL';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.headerText}>价格</Text>
        <Text style={styles.headerText}>数量</Text>
      </View>
      <View style={styles.levels}>
        {asks.slice(0, 5).reverse().map((level, index) => (
          <BookLevel
            key={`ask-${level.price}-${index}`}
            color={colors.red}
            level={level}
            pricePrecision={pricePrecision}
            onPress={onPricePress}
          />
        ))}
      </View>
      <View style={styles.midPrice}>
        <Text style={[styles.lastPrice, priceUp ? styles.up : styles.down]}>
          {formatSpotNumber(lastPrice, pricePrecision)}
        </Text>
        <Text style={styles.midMeta}>最新价</Text>
      </View>
      <View style={styles.levels}>
        {bids.slice(0, 5).map((level, index) => (
          <BookLevel
            key={`bid-${level.price}-${index}`}
            color={colors.green}
            level={level}
            pricePrecision={pricePrecision}
            onPress={onPricePress}
          />
        ))}
      </View>
      {asks.length === 0 && bids.length === 0 ? (
        <Text style={styles.empty}>暂无盘口数据</Text>
      ) : null}
    </View>
  );
}

export default React.memo(TradeOrderBook);

function BookLevel({
  color,
  level,
  pricePrecision,
  onPress,
}: {
  color: string;
  level: SpotOrderBookLevel;
  pricePrecision: number;
  onPress: (price: string) => void;
}) {
  const price = formatSpotNumber(level.price, pricePrecision);
  return (
    <Pressable style={styles.level} onPress={() => onPress(price)}>
      <Text style={[styles.levelPrice, {color}]}>{price}</Text>
      <Text style={styles.levelAmount}>{formatSpotNumber(level.amount, 4)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 142,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  headerText: {
    color: colors.textSubtle,
    fontSize: 10,
  },
  levels: {
    gap: 3,
  },
  level: {
    height: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  levelPrice: {
    ...typography.number,
    fontSize: 10,
    fontWeight: '800',
  },
  levelAmount: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 10,
  },
  midPrice: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line,
    marginVertical: 7,
  },
  lastPrice: {
    ...typography.number,
    fontSize: 15,
    fontWeight: '900',
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  midMeta: {
    marginTop: 2,
    color: colors.textSubtle,
    fontSize: 9,
  },
  empty: {
    marginTop: 10,
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'center',
  },
});
