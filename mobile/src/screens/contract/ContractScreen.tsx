import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import AppScreen from '../../components/common/AppScreen';
import SectionTitle from '../../components/common/SectionTitle';
import {colors, typography} from '../../theme';

const contractTypes = [
  'USDT合约',
  '股票合约',
  'CFD',
  '外汇',
  '金属',
  '商品',
  '指数',
];

export default function ContractScreen() {
  return (
    <AppScreen>
      <SectionTitle title="合约分类" />
      <Text style={styles.hint}>仅提供分类入口 UI，不包含真实交易、撮合或 WebSocket。</Text>
      <View style={styles.grid}>
        {contractTypes.map(item => (
          <Pressable key={item} style={styles.card}>
            <View style={styles.mark}>
              <Text style={styles.markText}>{item.slice(0, 1)}</Text>
            </View>
            <Text style={styles.title}>{item}</Text>
            <Text style={styles.desc}>查看可交易品种</Text>
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
  grid: {
    marginTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '48.5%',
    minHeight: 116,
    padding: 14,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  mark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  markText: {
    ...typography.heavy,
    color: colors.primary,
    fontSize: 14,
  },
  title: {
    ...typography.bold,
    marginTop: 14,
    color: colors.text,
    fontSize: 16,
  },
  desc: {
    ...typography.regular,
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 12,
  },
});
