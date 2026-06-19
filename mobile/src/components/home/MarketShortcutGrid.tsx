import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';

const shortcuts = [
  {title: '加密货币', name: 'BTC', price: '104,820.5', change: '+2.14%'},
  {title: '股票', name: '英伟达', price: '176.80', change: '+1.08%'},
  {title: '链上交易', name: 'SPX', price: '1.42', change: '-0.32%'},
  {title: 'TradFi', name: '黄金', price: '3,386.1', change: '+0.46%'},
];

export default function MarketShortcutGrid() {
  return (
    <View style={styles.grid}>
      {shortcuts.map(item => {
        const up = item.change.startsWith('+');
        return (
          <Pressable key={item.title} style={styles.card}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.name}>{item.name}</Text>
            <View style={styles.row}>
              <Text style={styles.price}>{item.price}</Text>
              <Text style={[styles.change, up ? styles.up : styles.down]}>
                {item.change}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '48.5%',
    minHeight: 96,
    padding: 13,
    borderRadius: 8,
    backgroundColor: '#15171D',
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.12)',
  },
  title: {
    color: colors.textSubtle,
    fontSize: 12,
  },
  name: {
    marginTop: 7,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  row: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  price: {
    ...typography.number,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  change: {
    ...typography.number,
    fontSize: 12,
    fontWeight: '800',
  },
  up: {
    color: colors.green,
  },
  down: {
    color: colors.red,
  },
});
