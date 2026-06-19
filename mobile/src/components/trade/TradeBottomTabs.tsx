import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {SpotMyTradeItem, SpotOrderItem} from '../../api/spot';
import {colors, typography} from '../../theme';

export type TradeRecordTab = 'current' | 'history' | 'fills';

type Props = {
  activeTab: TradeRecordTab;
  isLoggedIn: boolean;
  currentOrders: SpotOrderItem[];
  historyOrders: SpotOrderItem[];
  fills: SpotMyTradeItem[];
  error?: string | null;
  onChange: (tab: TradeRecordTab) => void;
  onLoginPress: () => void;
};

const tabs: Array<{key: TradeRecordTab; label: string}> = [
  {key: 'current', label: '当前委托'},
  {key: 'history', label: '历史委托'},
  {key: 'fills', label: '成交明细'},
];

function TradeBottomTabs({
  activeTab,
  isLoggedIn,
  currentOrders,
  historyOrders,
  fills,
  error,
  onChange,
  onLoginPress,
}: Props) {
  const items =
    activeTab === 'current'
      ? currentOrders
      : activeTab === 'history'
        ? historyOrders
        : fills;

  return (
    <View style={styles.card}>
      <View style={styles.tabs}>
        {tabs.map(tab => {
          const active = tab.key === activeTab;
          return (
            <Pressable key={tab.key} style={styles.tab} onPress={() => onChange(tab.key)}>
              <Text style={[styles.tabText, active ? styles.activeText : null]}>
                {tab.label}
              </Text>
              <View style={[styles.indicator, active ? styles.activeIndicator : null]} />
            </Pressable>
          );
        })}
      </View>

      {!isLoggedIn ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>登录后查看交易记录</Text>
          <Pressable style={styles.loginButton} onPress={onLoginPress}>
            <Text style={styles.loginText}>登录</Text>
          </Pressable>
        </View>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={styles.placeholder}>暂无记录</Text>
      ) : (
        <View style={styles.records}>
          {items.slice(0, 4).map(item => (
            <RecordRow key={item.id} item={item} />
          ))}
        </View>
      )}
    </View>
  );
}

export default React.memo(TradeBottomTabs);

function RecordRow({item}: {item: SpotOrderItem | SpotMyTradeItem}) {
  const side = item.side === 'SELL' ? '卖出' : '买入';
  const sideColor = item.side === 'SELL' ? colors.red : colors.green;
  return (
    <View style={styles.recordRow}>
      <View>
        <Text style={[styles.recordSide, {color: sideColor}]}>{side}</Text>
        <Text style={styles.recordMeta}>{item.symbol}</Text>
      </View>
      <View style={styles.recordRight}>
        <Text style={styles.recordValue}>{item.price}</Text>
        <Text style={styles.recordMeta}>{item.amount}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  tabs: {
    flexDirection: 'row',
    gap: 16,
  },
  tab: {
    height: 30,
    justifyContent: 'center',
  },
  tabText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
  },
  activeText: {
    color: colors.gold,
    fontWeight: '900',
  },
  indicator: {
    position: 'absolute',
    bottom: 0,
    width: 18,
    height: 2,
    borderRadius: 1,
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
  empty: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: 12,
  },
  loginButton: {
    height: 32,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.gold,
  },
  loginText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 12,
  },
  error: {
    marginTop: 14,
    color: colors.warning,
    fontSize: 12,
  },
  placeholder: {
    marginTop: 18,
    color: colors.textSubtle,
    fontSize: 12,
  },
  records: {
    marginTop: 8,
  },
  recordRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  recordSide: {
    ...typography.bold,
    fontSize: 12,
  },
  recordMeta: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 10,
  },
  recordRight: {
    alignItems: 'flex-end',
  },
  recordValue: {
    ...typography.number,
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
});
