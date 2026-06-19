import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {
  ContractOrderItem,
  ContractPositionItem,
  ContractTradeItem,
} from '../../api/contract';
import {colors, typography} from '../../theme';

export type ContractRecordTab = 'positions' | 'current' | 'history' | 'fills';

type Props = {
  activeTab: ContractRecordTab;
  isLoggedIn: boolean;
  positions: ContractPositionItem[];
  currentOrders: ContractOrderItem[];
  historyOrders: ContractOrderItem[];
  fills: ContractTradeItem[];
  error?: string | null;
  onChange: (tab: ContractRecordTab) => void;
  onLoginPress: () => void;
};

function ContractBottomTabs({
  activeTab,
  isLoggedIn,
  positions,
  currentOrders,
  historyOrders,
  fills,
  error,
  onChange,
  onLoginPress,
}: Props) {
  const tabs: Array<{key: ContractRecordTab; label: string}> = [
    {key: 'positions', label: `持仓(${positions.length})`},
    {key: 'current', label: `委托(${currentOrders.length})`},
    {key: 'history', label: '历史'},
    {key: 'fills', label: '成交'},
  ];
  const items =
    activeTab === 'positions'
      ? positions
      : activeTab === 'current'
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
          <Text style={styles.emptyTitle}>登录后查看合约持仓、委托和成交记录</Text>
          <Pressable style={styles.loginButton} onPress={onLoginPress}>
            <Text style={styles.loginText}>登录</Text>
          </Pressable>
        </View>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={styles.placeholder}>暂无合约记录</Text>
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

export default React.memo(ContractBottomTabs);

function RecordRow({
  item,
}: {
  item: ContractPositionItem | ContractOrderItem | ContractTradeItem;
}) {
  const isShort = 'positionSide' in item ? item.positionSide === 'SHORT' : item.side === 'SHORT';
  const label =
    'entryPrice' in item
      ? isShort
        ? '空仓'
        : '多仓'
      : `${item.action} ${isShort ? '空' : '多'}`;
  const value = 'entryPrice' in item ? item.entryPrice : item.price;
  const amount = 'quantity' in item ? item.quantity : '--';
  return (
    <View style={styles.recordRow}>
      <View>
        <Text style={[styles.recordSide, {color: isShort ? colors.red : colors.green}]}>
          {label}
        </Text>
        <Text style={styles.recordMeta}>{item.symbol}</Text>
      </View>
      <View style={styles.recordRight}>
        <Text style={styles.recordValue}>{value}</Text>
        <Text style={styles.recordMeta}>{amount}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
  },
  tabs: {
    flexDirection: 'row',
    gap: 15,
  },
  tab: {
    height: 28,
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
    backgroundColor: 'transparent',
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
  empty: {
    minHeight: 78,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: 12,
  },
  loginButton: {
    height: 31,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    backgroundColor: colors.gold,
  },
  loginText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 12,
  },
  error: {
    marginTop: 12,
    color: colors.warning,
    fontSize: 12,
  },
  placeholder: {
    marginTop: 16,
    color: colors.textSubtle,
    fontSize: 12,
  },
  records: {
    marginTop: 7,
  },
  recordRow: {
    minHeight: 42,
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
