import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import MarketRow from '../common/MarketRow';
import {colors} from '../../theme';

const tabs = ['自选', '热门', '涨幅榜', '跌幅榜', '新币榜', '成交额榜'];

const markets = [
  {name: 'BTC/USDT', price: '104,820.5', change: 2.14},
  {name: 'ETH/USDT', price: '2,518.22', change: 1.26},
  {name: 'RCB/USDT', price: '0.0842', change: 8.92},
  {name: 'XRP/USDT', price: '2.18', change: -0.58},
  {name: 'UNI/USDT', price: '7.42', change: 3.2},
  {name: 'DOGE/USDT', price: '0.1763', change: -1.42},
];

export default function TabbedMarketList() {
  return (
    <View>
      <View style={styles.tabs}>
        {tabs.map((item, index) => (
          <Pressable
            key={item}
            style={[styles.tab, index === 1 ? styles.activeTab : null]}>
            <Text style={[styles.tabText, index === 1 ? styles.activeText : null]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.list}>
        {markets.map(item => (
          <MarketRow key={item.name} {...item} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: colors.card,
  },
  activeTab: {
    backgroundColor: colors.primarySoft,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  activeText: {
    color: colors.primary,
  },
  list: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
