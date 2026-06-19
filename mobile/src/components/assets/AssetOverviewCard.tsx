import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {Eye, EyeOff} from 'lucide-react-native';
import {formatAssetNumber} from '../../api/assets';
import {colors, typography} from '../../theme';

type Props = {
  totalUsdt: number;
  hidden: boolean;
  loading?: boolean;
  onToggleHidden: () => void;
};

function AssetOverviewCard({
  totalUsdt,
  hidden,
  loading = false,
  onToggleHidden,
}: Props) {
  const displayAmount = hidden
    ? '******'
    : loading
      ? '--'
      : formatAssetNumber(totalUsdt, 2);
  const approxUsd = hidden ? '******' : loading ? '--' : formatAssetNumber(totalUsdt, 2);
  const Icon = hidden ? EyeOff : Eye;

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View>
          <View style={styles.labelRow}>
            <Text style={styles.label}>总资产估值</Text>
            <Pressable
              accessibilityLabel={hidden ? '显示资产' : '隐藏资产'}
              accessibilityRole="button"
              style={styles.eyeButton}
              onPress={onToggleHidden}>
              <Icon color={colors.textMuted} size={14} strokeWidth={2.2} />
            </Pressable>
          </View>
          <Text style={styles.amount}>{displayAmount} USDT</Text>
          <Text style={styles.usd}>≈ {approxUsd} USD</Text>
        </View>
        <View style={styles.chartWrap}>
          <Svg width="96" height="64" viewBox="0 0 96 64">
            <Path
              d="M8 44 L20 44 L20 36 L29 36 L29 41 L40 41 L40 30 L52 30 L52 35 L63 35 L63 25 L76 25 L76 18 L88 18"
              fill="none"
              stroke={colors.gold}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="3"
            />
            <Path
              d="M8 54 C22 48 32 52 44 43 C58 32 70 36 88 24"
              fill="none"
              stroke="rgba(25,195,125,0.68)"
              strokeLinecap="round"
              strokeWidth="2"
            />
            <Circle cx="88" cy="18" fill={colors.gold} r="3" />
          </Svg>
        </View>
      </View>
      <View style={styles.footerRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>计价单位</Text>
          <Text style={styles.metricValue}>USDT</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>资产视图</Text>
          <Text style={styles.metricValue}>总览</Text>
        </View>
      </View>
    </View>
  );
}

export default React.memo(AssetOverviewCard);

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.24)',
    backgroundColor: colors.card,
    padding: 16,
  },
  topRow: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
  },
  eyeButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amount: {
    ...typography.number,
    marginTop: 8,
    color: colors.text,
    fontSize: 30,
    fontWeight: '900',
  },
  usd: {
    ...typography.number,
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 12,
  },
  chartWrap: {
    width: 104,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.bgElevated,
  },
  footerRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  metricLabel: {
    color: colors.textSubtle,
    fontSize: 10,
  },
  metricValue: {
    ...typography.bold,
    marginTop: 4,
    color: colors.gold,
    fontSize: 12,
  },
});
