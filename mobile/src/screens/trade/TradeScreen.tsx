import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import AppScreen from '../../components/common/AppScreen';
import SectionTitle from '../../components/common/SectionTitle';
import {colors, typography} from '../../theme';

const tradeEntries = [
  {
    title: '现货交易',
    desc: '选择 BTC、ETH、UNI 等交易对后进入现货交易页',
  },
  {
    title: 'RWA交易',
    desc: '链上资产与 RWA 品种入口，当前仅展示页面骨架',
  },
  {
    title: '股票 / 股票合约',
    desc: '从股票行情选择品种后进入对应交易或合约页面',
  },
];

export default function TradeScreen() {
  return (
    <AppScreen>
      <SectionTitle title="交易入口" />
      <Text style={styles.hint}>选择品种后进入对应交易页，本版本不迁移 K 线交易页。</Text>
      <View style={styles.list}>
        {tradeEntries.map(item => (
          <Pressable key={item.title} style={styles.card}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.desc}>{item.desc}</Text>
            <Text style={styles.action}>进入占位</Text>
          </Pressable>
        ))}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  hint: {
    ...typography.body,
    color: colors.textMuted,
  },
  list: {
    marginTop: 14,
    gap: 12,
  },
  card: {
    minHeight: 104,
    padding: 16,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 17,
  },
  desc: {
    ...typography.body,
    marginTop: 8,
    color: colors.textMuted,
  },
  action: {
    ...typography.bold,
    marginTop: 12,
    color: colors.primary,
    fontSize: 12,
  },
});
