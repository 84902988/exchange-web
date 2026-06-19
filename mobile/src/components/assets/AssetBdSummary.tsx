import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {AssetBdOverview} from '../../api/assets';
import {colors, typography} from '../../theme';
import AssetEmptyState from './AssetEmptyState';

type Props = {
  overview: AssetBdOverview | null;
  isLoggedIn: boolean;
  loading?: boolean;
  error?: string | null;
  onLoginPress: () => void;
};

function AssetBdSummary({
  overview,
  isLoggedIn,
  loading = false,
  error,
  onLoginPress,
}: Props) {
  if (!isLoggedIn) {
    return (
      <AssetEmptyState
        actionLabel="登录"
        title="登录后查看代理收益"
        description="代理账户开通后，可查看团队与佣金概览。"
        onActionPress={onLoginPress}
      />
    );
  }

  if (error) {
    return <AssetEmptyState title="代理数据暂不可用" description={error} />;
  }

  if ((!overview || !overview.isBd) && !loading) {
    return (
      <AssetEmptyState
        title="暂无代理资产"
        description="当前账户尚未开通代理权益，佣金数据不会被模拟展示。"
      />
    );
  }

  const asset = overview?.settlementAsset || 'USDT';
  return (
    <View style={styles.card}>
      <Text style={styles.title}>代理收益</Text>
      <View style={styles.grid}>
        <Metric label="代理等级" value={overview?.bdLevel ?? '--'} />
        <Metric label="团队人数" value={`${overview?.teamCount ?? '--'}`} />
        <Metric label="累计佣金" value={`${overview?.totalCommission ?? '--'} ${asset}`} />
        <Metric label="待发佣金" value={`${overview?.pendingCommission ?? '--'} ${asset}`} />
      </View>
      <Text style={styles.note}>
        已发佣金 {overview?.paidCommission ?? '--'} {asset}
      </Text>
    </View>
  );
}

export default React.memo(AssetBdSummary);

function Metric({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  grid: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    width: '48%',
    minHeight: 58,
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
    ...typography.number,
    marginTop: 6,
    color: colors.text,
    fontSize: 13,
    fontWeight: '900',
  },
  note: {
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
});
