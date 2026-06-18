import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors} from '../../theme';

export default function PromoStrip() {
  return (
    <View style={styles.wrap}>
      <View style={styles.banner}>
        <Text style={styles.title}>活动中心</Text>
        <Text style={styles.desc}>新人任务、VIP 权益、IPO Prime 与委员会入口</Text>
      </View>
      <View style={styles.dotRow}>
        <View style={styles.activeDot} />
        <View style={styles.dot} />
        <View style={styles.dot} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  banner: {
    minHeight: 90,
    borderRadius: 8,
    padding: 16,
    justifyContent: 'center',
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.line,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  desc: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  activeDot: {
    width: 16,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textSubtle,
  },
});
