import React, {useMemo} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import OrderBookDepthFooter from '../common/OrderBookDepthFooter';
import {
  formatContractNumber,
  type ContractMarketTrade,
  type ContractOrderBookLevel,
} from '../../api/contract';
import {colors, typography} from '../../theme';
import {aggregateOrderBookLevels} from '../../utils/orderBookDepth';
import {
  MOBILE_ORDER_BOOK_DEPTH_STEP,
  MOBILE_ORDER_BOOK_MID_HEIGHT,
  MOBILE_ORDER_BOOK_ROWS,
  MOBILE_ORDER_BOOK_ROW_HEIGHT,
} from '../../constants/tradingLayout';

type Props = {
  asks: ContractOrderBookLevel[];
  bids: ContractOrderBookLevel[];
  trades: ContractMarketTrade[];
  lastPrice: number | null;
  markPrice: number | null;
  pricePrecision: number;
  onPricePress: (price: string) => void;
};

function ContractOrderBook({
  asks,
  bids,
  trades,
  lastPrice,
  markPrice,
  pricePrecision,
  onPricePress,
}: Props) {
  const latestTrade = trades[0];
  const priceUp = latestTrade?.side !== 'SELL';
  const aggregatedAsks = useMemo(
    () => aggregateOrderBookLevels(asks, 'ask', MOBILE_ORDER_BOOK_DEPTH_STEP),
    [asks],
  );
  const aggregatedBids = useMemo(
    () => aggregateOrderBookLevels(bids, 'bid', MOBILE_ORDER_BOOK_DEPTH_STEP),
    [bids],
  );
  const visibleAsks = aggregatedAsks.slice(-MOBILE_ORDER_BOOK_ROWS);
  const visibleBids = aggregatedBids.slice(0, MOBILE_ORDER_BOOK_ROWS);
  const maxAmount = Math.max(
    1,
    ...visibleAsks.map(level => Number(level.amount) || 0),
    ...visibleBids.map(level => Number(level.amount) || 0),
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.headerText}>价格(USDT)</Text>
        <Text style={styles.headerTextRight}>数量(BTC)</Text>
      </View>
      <View style={styles.levels}>
        {Array.from({length: MOBILE_ORDER_BOOK_ROWS}).map((_, index) => (
          <BookLevel
            key={`ask-${index}`}
            color={colors.red}
            level={visibleAsks[index] ?? null}
            maxAmount={maxAmount}
            pricePrecision={pricePrecision}
            onPress={onPricePress}
          />
        ))}
      </View>
      <View style={styles.midPrice}>
        <Text style={[styles.lastPrice, priceUp ? styles.up : styles.down]}>
          {formatContractNumber(lastPrice, pricePrecision)}
        </Text>
        <Text style={styles.midMeta}>
          标记价 {formatContractNumber(markPrice, pricePrecision)}
        </Text>
      </View>
      <View style={styles.levels}>
        {Array.from({length: MOBILE_ORDER_BOOK_ROWS}).map((_, index) => (
          <BookLevel
            key={`bid-${index}`}
            color={colors.green}
            level={visibleBids[index] ?? null}
            maxAmount={maxAmount}
            pricePrecision={pricePrecision}
            onPress={onPricePress}
          />
        ))}
      </View>
      <OrderBookDepthFooter asks={visibleAsks} bids={visibleBids} />
    </View>
  );
}

export default React.memo(ContractOrderBook);

function BookLevel({
  color,
  level,
  maxAmount,
  pricePrecision,
  onPress,
}: {
  color: string;
  level: ContractOrderBookLevel | null;
  maxAmount: number;
  pricePrecision: number;
  onPress: (price: string) => void;
}) {
  const price = level ? formatContractNumber(level.price, pricePrecision) : '--';
  const amount = level ? formatContractNumber(level.amount, 4) : '--';
  const ratio = level
    ? Math.max(8, Math.min(100, (Number(level.amount) / maxAmount) * 100))
    : 0;
  const depthWidth = `${ratio}%` as DimensionValue;

  return (
    <Pressable disabled={!level} style={styles.level} onPress={() => onPress(price)}>
      {level ? (
        <View style={[styles.depthBar, {backgroundColor: color, width: depthWidth}]} />
      ) : null}
      <Text style={[styles.levelPrice, level ? {color} : styles.placeholderText]}>
        {price}
      </Text>
      <Text style={[styles.levelAmount, !level ? styles.placeholderText : null]}>
        {amount}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    height: '100%',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  headerText: {
    color: colors.textSubtle,
    fontSize: 9,
  },
  headerTextRight: {
    color: colors.textSubtle,
    fontSize: 9,
    textAlign: 'right',
  },
  levels: {
    gap: 1,
  },
  level: {
    height: MOBILE_ORDER_BOOK_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
    paddingHorizontal: 1,
  },
  depthBar: {
    position: 'absolute',
    top: 1,
    right: 0,
    bottom: 1,
    opacity: 0.07,
    borderRadius: 2,
  },
  levelPrice: {
    ...typography.number,
    flex: 1,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'right',
  },
  levelAmount: {
    ...typography.number,
    flex: 1,
    color: colors.textMuted,
    fontSize: 10,
    textAlign: 'right',
  },
  midPrice: {
    height: MOBILE_ORDER_BOOK_MID_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line,
    marginVertical: 5,
  },
  lastPrice: {
    ...typography.number,
    fontSize: 16,
    fontWeight: '900',
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  midMeta: {
    marginTop: 1,
    color: colors.textSubtle,
    fontSize: 9,
  },
  placeholderText: {
    color: colors.textSubtle,
  },
});
