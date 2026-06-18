import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import PrimaryButton from '../common/PrimaryButton';
import {colors, typography} from '../../theme';

export default function AssetSummary() {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>总资产估值</Text>
      <View style={styles.row}>
        <Text style={styles.amount}>5.22 USDT</Text>
        <View style={styles.button}>
          <PrimaryButton title="充值" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 18,
    borderRadius: 8,
    padding: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
  },
  row: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  amount: {
    ...typography.number,
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
  },
  button: {
    width: 88,
  },
});
