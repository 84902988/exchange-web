import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import AppScreen from '../../components/common/AppScreen';
import MarketRow from '../../components/common/MarketRow';
import SearchBar from '../../components/common/SearchBar';
import SectionTitle from '../../components/common/SectionTitle';
import {colors, typography} from '../../theme';

const categories = ['总览', '自选', '加密货币', '股票', 'CFD'];
const instruments = [
  {name: 'BTC/USDT', price: '104,820.5', change: 2.14, subtitle: '加密货币'},
  {name: 'RCB/USDT', price: '0.0842', change: 8.92, subtitle: '加密货币'},
  {name: '纳斯达克', price: '19,447.8', change: -0.24, subtitle: '指数'},
  {name: '黄金', price: '3,386.1', change: 0.46, subtitle: '金属'},
  {name: 'NVDA', price: '176.80', change: 1.08, subtitle: '股票'},
  {name: 'EUR/USD', price: '1.1488', change: -0.18, subtitle: '外汇'},
];

export default function MarketsScreen() {
  return (
    <AppScreen>
      <View style={styles.top}>
        <SearchBar placeholder="搜索币种、股票、外汇" />
      </View>
      <View style={styles.categories}>
        {categories.map((item, index) => (
          <Pressable
            key={item}
            style={[styles.category, index === 0 ? styles.activeCategory : null]}>
            <Text
              style={[
                styles.categoryText,
                index === 0 ? styles.activeCategoryText : null,
              ]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>
      <SectionTitle title="市场列表" action="点击为占位" />
      <View style={styles.list}>
        {instruments.map(item => (
          <MarketRow key={item.name} {...item} />
        ))}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  top: {
    paddingTop: 4,
  },
  categories: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 8,
  },
  category: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: colors.card,
  },
  activeCategory: {
    backgroundColor: colors.primarySoft,
  },
  categoryText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
  },
  activeCategoryText: {
    color: colors.primary,
  },
  list: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
