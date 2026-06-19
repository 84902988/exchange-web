import React from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ArrowLeft, MoreHorizontal} from 'lucide-react-native';
import {
  formatSpotNumber,
  formatSpotPercent,
  type SpotKline,
  type SpotOrderBookLevel,
  type SpotTrade,
} from '../../api/spot';
import {colors, typography} from '../../theme';
import MobileKlineChart from './MobileKlineChart';
import type {KlineInterval} from './kline.utils';

type Props = {
  visible: boolean;
  symbolLabel: string;
  lastPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
  klines: SpotKline[];
  interval: KlineInterval;
  loading?: boolean;
  error?: string | null;
  bids: SpotOrderBookLevel[];
  asks: SpotOrderBookLevel[];
  trades: SpotTrade[];
  onIntervalChange: (interval: KlineInterval) => void;
  onClose: () => void;
};

export default function TradeChartModal({
  visible,
  symbolLabel,
  lastPrice,
  changePercent,
  pricePrecision,
  klines,
  interval,
  loading = false,
  error = null,
  bids,
  asks,
  trades,
  onIntervalChange,
  onClose,
}: Props) {
  const up = (changePercent || 0) >= 0;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.safe}>
        <View style={styles.header}>
          <Pressable style={styles.back} onPress={onClose}>
            <ArrowLeft color={colors.text} size={21} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.symbol}>{symbolLabel}</Text>
            <Text style={[styles.change, up ? styles.up : styles.down]}>
              {formatSpotPercent(changePercent)}
            </Text>
          </View>
          <MoreHorizontal color={colors.textMuted} size={22} strokeWidth={2.2} />
        </View>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}>
          <Text style={[styles.bigPrice, up ? styles.up : styles.down]}>
            {formatSpotNumber(lastPrice, pricePrecision)}
          </Text>
          <Text style={styles.chartTitle}>{symbolLabel} K线</Text>
          <MobileKlineChart
            error={error}
            height={320}
            interval={interval}
            items={klines}
            loading={loading}
            pricePrecision={pricePrecision}
            visibleCount={56}
            onIntervalChange={onIntervalChange}
          />
          <View style={styles.twoCols}>
            <Panel title="盘口">
              {asks.slice(0, 4).map((item, index) => (
                <Level key={`ask-${index}`} color={colors.red} item={item} />
              ))}
              {bids.slice(0, 4).map((item, index) => (
                <Level key={`bid-${index}`} color={colors.green} item={item} />
              ))}
            </Panel>
            <Panel title="成交">
              {trades.slice(0, 8).map(item => (
                <View key={item.id} style={styles.row}>
                  <Text
                    style={[
                      styles.rowPrice,
                      item.side === 'SELL' ? styles.down : styles.up,
                    ]}>
                    {formatSpotNumber(item.price, pricePrecision)}
                  </Text>
                  <Text style={styles.rowAmount}>
                    {formatSpotNumber(item.amount, 4)}
                  </Text>
                </View>
              ))}
            </Panel>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Panel({children, title}: {children: React.ReactNode; title: string}) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Level({color, item}: {color: string; item: SpotOrderBookLevel}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowPrice, {color}]}>{formatSpotNumber(item.price, 2)}</Text>
      <Text style={styles.rowAmount}>{formatSpotNumber(item.amount, 4)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: {
    width: 36,
    height: 36,
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  symbol: {
    ...typography.heavy,
    color: colors.text,
    fontSize: 15,
  },
  change: {
    ...typography.number,
    marginTop: 3,
    fontSize: 11,
    fontWeight: '800',
  },
  content: {
    padding: 14,
    paddingBottom: 30,
  },
  bigPrice: {
    ...typography.number,
    marginBottom: 8,
    fontSize: 30,
    fontWeight: '900',
  },
  chartTitle: {
    ...typography.bold,
    marginBottom: 10,
    color: colors.text,
    fontSize: 14,
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
  twoCols: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10,
  },
  panel: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 10,
  },
  panelTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 12,
    marginBottom: 8,
  },
  row: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowPrice: {
    ...typography.number,
    fontSize: 10,
    fontWeight: '800',
  },
  rowAmount: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 10,
  },
});
