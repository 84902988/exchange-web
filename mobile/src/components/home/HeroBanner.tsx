import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import PrimaryButton from '../common/PrimaryButton';
import {colors, typography} from '../../theme';

type Props = {
  onLogin?: () => void;
  onRegister?: () => void;
};

export default function HeroBanner({onLogin, onRegister}: Props) {
  return (
    <View style={styles.hero}>
      <View style={styles.glow} />
      <Text style={styles.kicker}>WELCOME BONUS</Text>
      <Text style={styles.title}>立即注册，领取 6200 USDT</Text>
      <Text style={styles.subtitle}>多市场行情、现货、合约与资产入口已就绪</Text>
      <View style={styles.marketTape}>
        <Text style={styles.tapeText}>BTC +2.14%</Text>
        <Text style={styles.tapeText}>NVDA +1.08%</Text>
        <Text style={styles.tapeDown}>XAU -0.42%</Text>
      </View>
      <View style={styles.actions}>
        <View style={styles.actionButton}>
          <PrimaryButton title="登录" variant="secondary" onPress={onLogin} />
        </View>
        <View style={styles.actionButton}>
          <PrimaryButton title="注册" onPress={onRegister} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: 16,
    aspectRatio: 3 / 4,
    overflow: 'hidden',
    borderRadius: 12,
    padding: 20,
    justifyContent: 'flex-end',
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: colors.line,
  },
  glow: {
    position: 'absolute',
    top: -100,
    right: -90,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(23, 212, 178, 0.18)',
  },
  kicker: {
    ...typography.number,
    color: colors.primary,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
  },
  title: {
    marginTop: 10,
    color: colors.text,
    fontSize: 31,
    lineHeight: 38,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  marketTape: {
    marginTop: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tapeText: {
    ...typography.number,
    color: colors.green,
    fontSize: 12,
    fontWeight: '800',
    backgroundColor: 'rgba(25, 195, 125, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  tapeDown: {
    ...typography.number,
    color: colors.red,
    fontSize: 12,
    fontWeight: '800',
    backgroundColor: 'rgba(240, 90, 90, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  actions: {
    marginTop: 20,
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
});
