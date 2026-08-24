import React, { useMemo, useRef } from 'react';
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
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';
import { formatFixedPrice } from '../../utils/format';
import { aggregateOrderBookLevels } from '../../utils/orderBookDepth';
import {
  MOBILE_ORDER_BOOK_DEPTH_STEP,
  MOBILE_ORDER_BOOK_MID_HEIGHT,
  MOBILE_ORDER_BOOK_ROWS,
} from '../../constants/tradingLayout';

type Props = {
  asks: ContractOrderBookLevel[];
  bids: ContractOrderBookLevel[];
  trades: ContractMarketTrade[];
  lastPrice: number | null;
  markPrice: number | null;
  pricePrecision: number;
  baseAsset: string;
  quoteAsset: string;
  onPricePress: (price: string) => void;
};

const CONTRACT_COMPLETE_DEPTH_RETAIN_MS = 1_500;

function ContractOrderBook({
  asks,
  bids,
  trades,
  lastPrice,
  pricePrecision,
  baseAsset,
  quoteAsset,
  onPricePress,
}: Props) {
  const { t } = useLanguage();
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
  const incomingAsks = aggregatedAsks.slice(-MOBILE_ORDER_BOOK_ROWS);
  const incomingBids = aggregatedBids.slice(0, MOBILE_ORDER_BOOK_ROWS);
  const marketKey = `${baseAsset}/${quoteAsset}`;
  const completeDepthRef = useRef({
    marketKey,
    asks: [] as ContractOrderBookLevel[],
    asksAtMs: 0,
    bids: [] as ContractOrderBookLevel[],
    bidsAtMs: 0,
  });
  if (completeDepthRef.current.marketKey !== marketKey) {
    completeDepthRef.current = {
      marketKey,
      asks: [],
      asksAtMs: 0,
      bids: [],
      bidsAtMs: 0,
    };
  }
  const nowMs = Date.now();
  if (incomingAsks.length >= MOBILE_ORDER_BOOK_ROWS) {
    completeDepthRef.current.asks = incomingAsks;
    completeDepthRef.current.asksAtMs = nowMs;
  }
  if (incomingBids.length >= MOBILE_ORDER_BOOK_ROWS) {
    completeDepthRef.current.bids = incomingBids;
    completeDepthRef.current.bidsAtMs = nowMs;
  }
  const visibleAsks =
    incomingAsks.length >= MOBILE_ORDER_BOOK_ROWS ||
    nowMs - completeDepthRef.current.asksAtMs >
      CONTRACT_COMPLETE_DEPTH_RETAIN_MS
      ? incomingAsks
      : completeDepthRef.current.asks;
  const visibleBids =
    incomingBids.length >= MOBILE_ORDER_BOOK_ROWS ||
    nowMs - completeDepthRef.current.bidsAtMs >
      CONTRACT_COMPLETE_DEPTH_RETAIN_MS
      ? incomingBids
      : completeDepthRef.current.bids;
  const maxAmount = Math.max(
    1,
    ...visibleAsks.map(level => Number(level.amount) || 0),
    ...visibleBids.map(level => Number(level.amount) || 0),
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text
          maxFontSizeMultiplier={1.15}
          numberOfLines={1}
          style={styles.headerText}
        >
          {t('trading.priceAsset', { asset: quoteAsset })}
        </Text>
        <Text
          maxFontSizeMultiplier={1.15}
          numberOfLines={1}
          style={styles.headerTextRight}
        >
          {t('trading.quantityAsset', { asset: baseAsset })}
        </Text>
      </View>
      <View style={styles.levels}>
        {Array.from({ length: MOBILE_ORDER_BOOK_ROWS }).map((_, index) => (
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
        <Text
          maxFontSizeMultiplier={1.15}
          numberOfLines={1}
          style={[styles.lastPrice, priceUp ? styles.up : styles.down]}
        >
          {formatFixedPrice(lastPrice, pricePrecision)}
        </Text>
      </View>
      <View style={styles.levels}>
        {Array.from({ length: MOBILE_ORDER_BOOK_ROWS }).map((_, index) => (
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

type BookLevelProps = {
  color: string;
  level: ContractOrderBookLevel | null;
  maxAmount: number;
  pricePrecision: number;
  onPress: (price: string) => void;
};

const BookLevel = React.memo(function BookLevelRow({
  color,
  level,
  maxAmount,
  pricePrecision,
  onPress,
}: BookLevelProps) {
  const { t } = useLanguage();
  const price = level
    ? formatFixedPrice(level.price, pricePrecision)
    : '--';
  const amount = level ? formatContractNumber(level.amount, 4) : '--';
  const ratio = level
    ? Math.max(8, Math.min(100, (Number(level.amount) / maxAmount) * 100))
    : 0;
  const depthWidth = `${ratio}%` as DimensionValue;

  return (
    <Pressable
      accessibilityLabel={
        level
          ? t('trading.selectPriceAmountA11y', { price, amount })
          : undefined
      }
      accessibilityRole={level ? 'button' : undefined}
      accessibilityState={{ disabled: !level }}
      android_ripple={level ? { color: 'rgba(212, 175, 55, 0.08)' } : undefined}
      disabled={!level}
      style={({ pressed }) => [styles.level, pressed ? styles.pressed : null]}
      onPress={() => onPress(price)}
    >
      {level ? (
        <View
          style={[
            styles.depthBar,
            { backgroundColor: color, width: depthWidth },
          ]}
        />
      ) : null}
      <Text
        maxFontSizeMultiplier={1.15}
        numberOfLines={1}
        style={[styles.levelPrice, level ? { color } : styles.placeholderText]}
      >
        {price}
      </Text>
      <Text
        maxFontSizeMultiplier={1.15}
        numberOfLines={1}
        style={[styles.levelAmount, !level ? styles.placeholderText : null]}
      >
        {amount}
      </Text>
    </Pressable>
  );
},
areBookLevelPropsEqual);

function areBookLevelPropsEqual(
  previous: BookLevelProps,
  next: BookLevelProps,
) {
  return (
    previous.color === next.color &&
    previous.maxAmount === next.maxAmount &&
    previous.pricePrecision === next.pricePrecision &&
    previous.onPress === next.onPress &&
    previous.level?.price === next.level?.price &&
    previous.level?.amount === next.level?.amount
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72 },
  card: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
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
    fontSize: 10,
  },
  headerTextRight: {
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'right',
  },
  levels: {
    flex: 1,
    gap: 1,
  },
  level: {
    flex: 1,
    minHeight: 21,
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
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'right',
  },
  levelAmount: {
    ...typography.number,
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
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
  placeholderText: {
    color: colors.textSubtle,
  },
});
