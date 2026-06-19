import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';
import {type OrderBookDepthLevel} from '../../utils/orderBookDepth';
import {MOBILE_ORDER_BOOK_FOOTER_HEIGHT} from '../../constants/tradingLayout';

type Props = {
  asks: OrderBookDepthLevel[];
  bids: OrderBookDepthLevel[];
};

function OrderBookDepthFooter({asks, bids}: Props) {
  const bidTotal = bids.reduce((sum, item) => sum + safeAmount(item.amount), 0);
  const askTotal = asks.reduce((sum, item) => sum + safeAmount(item.amount), 0);
  const total = bidTotal + askTotal;

  const hasData = total > 0;

  const bidRatio = hasData ? Math.round((bidTotal / total) * 100) : 0;
  const askRatio = hasData ? 100 - bidRatio : 0;

  return (
    <View style={styles.footer}>
      {hasData ? (
        <View style={styles.ratioRow}>
          <Text style={[styles.ratioText, styles.bidText]}>B {bidRatio}%</Text>
          <View style={styles.ratioTrack}>
            <View style={[styles.ratioFill, styles.bidFill, {flex: bidTotal}]} />
            <View style={[styles.ratioFill, styles.askFill, {flex: askTotal}]} />
          </View>
          <Text style={[styles.ratioText, styles.askText]}>{askRatio}% S</Text>
        </View>
      ) : null}
    </View>
  );
}

export default React.memo(OrderBookDepthFooter);

function safeAmount(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const styles = StyleSheet.create({
  footer: {
    height: MOBILE_ORDER_BOOK_FOOTER_HEIGHT,
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  ratioRow: {
    height: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ratioText: {
    ...typography.number,
    width: 30,
    fontSize: 8,
    fontWeight: '700',
  },
  bidText: {
    color: colors.green,
  },
  askText: {
    color: colors.red,
    textAlign: 'right',
  },
  ratioTrack: {
    flex: 1,
    height: 3,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 2,
    backgroundColor: colors.bgElevated,
  },
  ratioFill: {
    height: 3,
    opacity: 0.36,
  },
  bidFill: {
    backgroundColor: colors.green,
  },
  askFill: {
    backgroundColor: colors.red,
  },
});
