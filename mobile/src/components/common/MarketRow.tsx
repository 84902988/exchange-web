import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';
import {signedPercent} from '../../utils/format';

type Props = {
  name: string;
  price: string;
  change: number;
  subtitle?: string;
};

export default function MarketRow({name, price, change, subtitle}: Props) {
  const up = change >= 0;
  return (
    <Pressable style={styles.row}>
      <View>
        <Text style={styles.name}>{name}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.right}>
        <Text style={styles.price}>{price}</Text>
        <View style={[styles.badge, up ? styles.up : styles.down]}>
          <Text style={styles.badgeText}>{signedPercent(change)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 4,
    color: colors.textSubtle,
    fontSize: 11,
  },
  right: {
    alignItems: 'flex-end',
  },
  price: {
    ...typography.number,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },
  badge: {
    minWidth: 76,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  up: {
    backgroundColor: colors.green,
  },
  down: {
    backgroundColor: colors.red,
  },
  badgeText: {
    ...typography.number,
    color: colors.white,
    fontSize: 12,
    fontWeight: '800',
  },
});
