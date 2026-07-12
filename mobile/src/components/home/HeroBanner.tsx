import React from 'react';
import {Image, StyleSheet, Text, View, type ImageStyle} from 'react-native';
import PrimaryButton from '../common/PrimaryButton';
import {colors, typography} from '../../theme';

type Props = {
  onLogin?: () => void;
  onRegister?: () => void;
};

const brandLogo = require('../../assets/brand/royal-exchange-logo.png');

export default function HeroBanner({onLogin, onRegister}: Props) {
  return (
    <View style={styles.hero}>
      <View style={styles.glow} />
      <Image
        source={brandLogo}
        style={styles.logo as ImageStyle}
        resizeMode="contain"
      />
      <Text style={styles.kicker}>WELCOME BONUS</Text>
      <Text style={styles.title}>立即注册，领取6200 USDT</Text>
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
    minHeight: 310,
    overflow: 'hidden',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 18,
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.22)',
  },
  glow: {
    position: 'absolute',
    top: -52,
    right: -54,
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: 'rgba(214, 168, 50, 0.28)',
  },
  logo: {
    width: 68,
    height: 58,
    marginLeft: 4,
    marginBottom: 18,
  },
  kicker: {
    ...typography.number,
    color: colors.gold,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
  },
  title: {
    ...typography.screenTitle,
    marginTop: 10,
    color: colors.text,
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
    gap: 7,
  },
  tapeText: {
    ...typography.number,
    color: colors.green,
    fontSize: 12,
    fontWeight: '800',
    backgroundColor: 'rgba(25, 195, 125, 0.16)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  tapeDown: {
    ...typography.number,
    color: colors.red,
    fontSize: 12,
    fontWeight: '800',
    backgroundColor: 'rgba(240, 90, 90, 0.16)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  actions: {
    marginTop: 22,
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
});
